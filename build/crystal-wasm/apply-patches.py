#!/usr/bin/env python3
"""Patch the Crystal source so the *compiler* can be built for wasm32-wasi.

    python3 apply-patches.py <crystal-src-root>

Two of the compiler's commands cannot exist in a wasm build:

  * `crystal play` starts an HTTP server -- it needs sockets, which WASI
    preview 1 does not have. Crystal already gates this behind
    `flag?(:without_playground)`, and the command dispatcher honours it, so
    playground needs no patch -- only `-Dwithout_playground` at compile time.

  * `crystal docs` pulls the `markd` shard (a binding to the md4c C library),
    which is not available and not wanted. There is no existing flag, so this
    adds one in the same style: skip the two files and make the dispatcher
    report the build has no docs support.

Each edit is an idempotent literal replacement; the script refuses to continue if
a target does not contain the expected text, so a Crystal version bump fails
loudly instead of silently skipping a fix.

Idempotency note: several patches only *insert* text, so their replacement
contains the original verbatim (`new ⊇ old`). For those, `new in text` is not a
usable "already applied" signal -- the old text survives inside the new one and
the patch would apply again on every run. They carry an explicit `marker`: a
string that appears only in the patched file. Patches whose new text cannot be a
substring of the old one need no marker.
"""
import pathlib
import sys
from gc_patches import GC_PATCHES

DOCS_SHIM_OLD = 'require "./doc/*"'
DOCS_SHIM_NEW = '{% skip_file if flag?(:without_docs) %}\n\nrequire "./doc/*"'

DOCS_CMD_OLD = "# Implementation of the `crystal docs` command"
DOCS_CMD_NEW = (
    "{% skip_file if flag?(:without_docs) %}\n\n"
    "# Implementation of the `crystal docs` command"
)

DISPATCH_OLD = """    when "docs".starts_with?(command)
      options.shift
      docs"""

DISPATCH_NEW = """    when "docs".starts_with?(command)
      options.shift
      {% if flag?(:without_docs) %}
        puts "Crystal was compiled without docs support"
        exit 1
      {% else %}
        docs
      {% end %}"""

# libffi's ABI enum has no wasm32 entry, so the compiler's FFI bindings fail to
# compile for the target. wasm32 is ILP32 like i386-unix, so it takes the same
# values; FFI cannot actually run on WASI (no dlopen), but it must typecheck.
FFI_ABI_OLD = """      {% else %}
        {% raise "Unsupported target for ABI" %}
      {% end %}"""

FFI_ABI_NEW = """      {% elsif flag?(:wasm32) %}
        # wasm32 is ILP32, like i386-unix -- the closest libffi ABI.
        SYSV     = 1
        THISCALL = 3
        FASTCALL
        STDCALL
        PASCAL
        REGISTER
        MS_CDECL
        LAST

        DEFAULT = SYSV
      {% else %}
        {% raise "Unsupported target for ABI" %}
      {% end %}"""

# The standard library guards the *bodies* of these two methods for
# `!flag?(:wasm32)`, but their return-type annotations still name `Signal` --
# and `Signal` is not defined on wasm (the prelude skips `require "signal"`).
# Guard the whole methods so the annotation goes with them.
STATUS_SIGNAL_OLD = """  def exit_signal : Signal
    {% if flag?(:unix) && !flag?(:wasm32) %}
      Signal.new(signal_code)
    {% else %}
      raise NotImplementedError.new("Process::Status#exit_signal")
    {% end %}
  end

  # Returns the exit `Signal` or `nil` if there is none.
  #
  # On Windows returns always `nil`.
  #
  # * `#exit_reason` is a portable alternative.
  def exit_signal? : Signal?
    {% if flag?(:unix) && !flag?(:wasm32) %}
      code = signal_code
      unless code.zero?
        Signal.new(code)
      end
    {% end %}
  end"""

STATUS_SIGNAL_NEW = """  {% if flag?(:unix) && !flag?(:wasm32) %}
    def exit_signal : Signal
      Signal.new(signal_code)
    end

    # Returns the exit `Signal` or `nil` if there is none.
    #
    # On Windows returns always `nil`.
    #
    # * `#exit_reason` is a portable alternative.
    def exit_signal? : Signal?
      code = signal_code
      unless code.zero?
        Signal.new(code)
      end
    end
  {% else %}
    # Signals do not exist on this platform; `#exit_reason` is the portable
    # alternative. The type annotation cannot name `Signal` here.
    def exit_signal : NoReturn
      raise NotImplementedError.new("Process::Status#exit_signal")
    end

    def exit_signal? : NoReturn
      raise NotImplementedError.new("Process::Status#exit_signal?")
    end
  {% end %}"""

EXEC_PATH_OLD = """    def self.exec_path
      ENV.fetch("CRYSTAL_EXEC_PATH") do
        executable_path = Process.executable_path || return
        File.dirname(executable_path)
      end
    end"""

EXEC_PATH_NEW = """    def self.exec_path : String
      ENV.fetch("CRYSTAL_EXEC_PATH") do
        {% if flag?(:wasm32) %}
          # WASI has no executable path; the compiler is configured through ENV.
          ""
        {% else %}
          executable_path = Process.executable_path
          executable_path ? File.dirname(executable_path) : ""
        {% end %}
      end
    end"""

# The WASI event loop leaves file open() as a NotImplementedError, so
# a Crystal program on wasm cannot read a file at all -- which a compiler must.
# The other event loops (see event_loop/polling.cr) all open with `LibC.open`;
# WASI can too, because wasi-libc implements open(2) over path_open against the
# preopened directories. WASI has no O_CLOEXEC and no way to change blocking
# mode after the fact, so the flags go through untouched and the descriptor is
# reported blocking (which is what it is).
WASI_OPEN_OLD = """  def open(path : String, flags : Int32, permissions : File::Permissions, blocking : Bool?) : {System::FileDescriptor::Handle, Bool} | Errno | WinError
    raise NotImplementedError.new("Crystal::Wasi::EventLoop#open")
  end"""

WASI_OPEN_NEW = """  def open(path : String, flags : Int32, permissions : File::Permissions, blocking : Bool?) : {System::FileDescriptor::Handle, Bool} | Errno | WinError
    path.check_no_null_byte

    fd = LibC.open(path, flags, permissions)
    return Errno.value if fd == -1

    # A descriptor from a WASI filesystem is blocking; there is no non-blocking
    # mode to switch to, so the caller is told what is true rather than what was
    # asked for.
    {fd, true}
  end"""

# Crystal 1.17 deliberately does not implement exceptions on wasm32: raise()
# calls `LibIntrinsics.debugtrap` (the `unreachable` seen at every run), and the
# three runtime hooks print "EXITING: ..." and exit. But the machinery for the
# funclet path is all present -- LLVM's wasm EH uses the Windows-style funclet
# IR (catchswitch/catchpad), and libunwind's wasm port (Unwind-wasm.c) provides
# `_Unwind_RaiseException` (a `wasm throw`), `_Unwind_GetIP`,
# `_Unwind_GetLanguageSpecificData` and `_Unwind_SetGR`. So the wasm stubs are
# removed and wasm uses the same implementations as every other platform.
WASM_RAISE_STUBS_OLD = """{% elsif flag?(:wasm32) %}
  # :nodoc:
  fun __crystal_personality
    Crystal::System.print_error "EXITING: __crystal_personality called"
    LibC.exit(1)
  end

  # :nodoc:
  @[Raises]
  fun __crystal_raise(ex : Void*) : NoReturn
    Crystal::System.print_error "EXITING: __crystal_raise called"
    LibC.exit(1)
  end

  # :nodoc:
  fun __crystal_get_exception(ex : Void*) : UInt64
    Crystal::System.print_error "EXITING: __crystal_get_exception called"
    LibC.exit(1)
    0u64
  end
{% else %}"""

WASM_RAISE_STUBS_NEW = """{% else %}"""

WASM_RAISE_UNLESS_OLD = "{% unless flag?(:interpreted) || (flag?(:win32) && !flag?(:gnu)) || flag?(:wasm32) %}"
WASM_RAISE_UNLESS_NEW = "{% unless flag?(:interpreted) || (flag?(:win32) && !flag?(:gnu)) %}"

WASM_RAISE_DEF_OLD = """{% if flag?(:wasm32) %}
  def raise(exception : Exception) : NoReturn
    Crystal::System.print_error "EXITING: Attempting to raise:\\n%s\\n", exception.inspect_with_backtrace
    LibIntrinsics.debugtrap
    LibC.exit(1)
  end
{% else %}
  # Raises the *exception*."""

WASM_RAISE_DEF_NEW = """  # Raises the *exception*."""

WASM_RAISE_DEF_END_OLD = """    exception.callstack ||= Exception::CallStack.new
    raise_without_backtrace(exception)
  end
{% end %}"""

WASM_RAISE_DEF_END_NEW = """    exception.callstack ||= Exception::CallStack.new
    raise_without_backtrace(exception)
  end"""

# `exception/call_stack.cr` picks `call_stack/null` on wasm, which does not
# require `exception/lib_unwind` -- so `LibUnwind` is not in scope once wasm uses
# the real raise path. Require it directly.
RAISE_REQUIRE_OLD = 'require "exception/call_stack"'
RAISE_REQUIRE_NEW = """require "exception/call_stack"
{% unless flag?(:interpreted) %}
  require "exception/lib_unwind"
{% end %}"""

# `raise` calls `Exception::CallStack.print_backtrace`, which the interpreter and
# libunwind call-stack implementations define but the null one (used on wasm)
# does not. A wasm backtrace is empty anyway; this satisfies the interface.
NULL_BACKTRACE_OLD = """  protected def self.decode_frame(pc)
    nil
  end"""

NULL_BACKTRACE_NEW = """  # The other call-stack implementations provide this; raise needs it.
  def self.print_backtrace : Nil
  end

  protected def self.decode_frame(pc)
    nil
  end"""

# WebAssembly's exception handling in LLVM uses the Windows-style *funclet*
# representation -- `catchswitch`/`catchpad`, lowered by the wasm backend to
# `try`/`catch __cpp_exception` (WebAssemblyISelDAGToDAG.cpp) -- not the Itanium
# landing pad Crystal emits by default. `WinEHPrepare` and `WasmEHPrepare` run
# the module for `ExceptionHandling::Wasm`, so a wasm target must take Crystal's
# msvc code path. `msvc` is a *runtime* program flag, so it is extended here with
# a runtime target check rather than `{% if flag?(:wasm32) %}` (which is
# evaluated when the *compiler* is built -- a natively-built bootstrap compiler
# would take the else branch).
MSVC_BRANCH_OLD = '    msvc = @program.has_flag?("msvc")'
MSVC_BRANCH_NEW = """    msvc = @program.has_flag?("msvc")
    # WebAssembly's exception handling in LLVM uses the funclet representation
    # (catchswitch/catchpad, lowered to `catch __cpp_exception`), which is the
    # same shape as the msvc path -- so a wasm target takes it.
    wasm_target = @program.target_machine.triple.starts_with?("wasm32")
    funclet_eh = msvc || wasm_target"""

# The personality function is per-function. WasmEHPrepare requires a *scoped*
# personality on every function that owns a catchpad; for wasm that is libc++abi's
# __gxx_wasm_personality_v0, where msvc uses __CxxFrameHandler3.
PERSONALITY_SET_OLD = "    context.fun.personality_function = windows_personality_fun.func if msvc"
PERSONALITY_SET_NEW = """    if msvc
      context.fun.personality_function = windows_personality_fun.func
    elsif wasm_target
      context.fun.personality_function = wasm_personality_fun.func
    end"""

# The rescue catchpad. wasm uses the same funclet IR as msvc, but the catchpad
# *shape* differs: wasm wants a single catch-all operand (`ptr null`) and delivers
# the caught exception through llvm.wasm.get.exception(token), which WasmEHPrepare
# rewrites to the wasm `catch` instruction. There is no catch-object slot, so the
# exception is unwrapped with __crystal_get_exception exactly as the Itanium
# landing-pad path does. (r-string: the old text contains a literal \n.)
CODEGEN_RESCUE_OLD = r"""      if msvc
        # Windows structured exception handling must enter a catch_switch instruction
        # which decides which catch body block to enter. Crystal only ever generates one catch body
        # which is used for all exceptions. For more information on how structured exception handling works in LLVM,
        # see https://llvm.org/docs/ExceptionHandling.html#exception-handling-using-the-windows-runtime
        catch_body = new_block "catch_body"
        catch_switch = builder.catch_switch(@catch_pad || LLVM::Value.null, @rescue_block || LLVM::BasicBlock.null, 1)
        builder.add_handler catch_switch, catch_body

        # We're now generating the catch body, which must begin with a catchpad instruction
        position_at_end catch_body

        # Allocate space for the caught exception
        exception_type = @program.exception.virtual_type
        exception_llvm_type = llvm_type(exception_type)
        caught_exception_ptr = alloca exception_llvm_type

        # The catchpad instruction dictates which types of exceptions this block handles,
        # we want all of them, so we rescue all void* by passing the void_ptr_type_descriptor.
        # We also need to record the catch pad instruction in `@catch_pad` to refer to the parent catch
        # pad in nested rescue blocks, and to generate funclet information for function calls which are
        # "inside" this catchpad. More information on this is available in the link above.
        @catch_pad = builder.catch_pad catch_switch, [void_ptr_type_descriptor, int32(0), caught_exception_ptr]

        # builder.printf("catchpad entered #{node.location}\n", catch_pad: @catch_pad)

        caught_exception = load exception_llvm_type, caught_exception_ptr
        exception_type_id = type_id(caught_exception, exception_type)
      else"""

CODEGEN_RESCUE_NEW = """      if funclet_eh
        # Windows structured exception handling must enter a catch_switch instruction
        # which decides which catch body block to enter. Crystal only ever generates one catch body
        # which is used for all exceptions. For more information on how structured exception handling works in LLVM,
        # see https://llvm.org/docs/ExceptionHandling.html#exception-handling-using-the-windows-runtime
        catch_body = new_block "catch_body"
        catch_switch = builder.catch_switch(@catch_pad || LLVM::Value.null, @rescue_block || LLVM::BasicBlock.null, 1)
        builder.add_handler catch_switch, catch_body

        # We're now generating the catch body, which must begin with a catchpad instruction
        position_at_end catch_body

        exception_type = @program.exception.virtual_type
        exception_llvm_type = llvm_type(exception_type)

        if wasm_target
          # WebAssembly reuses the funclet IR but not the msvc catchpad shape. Its
          # catchpad declares a single catch-all operand, and the caught exception
          # arrives through llvm.wasm.get.exception(token), which WasmEHPrepare
          # rewrites to the wasm `catch` instruction. There is no catch-object slot,
          # so the exception is unwrapped by __crystal_get_exception exactly as the
          # landing-pad path below does.
          catch_pad = builder.catch_pad catch_switch, [llvm_context.void_pointer.null]
          @catch_pad = catch_pad

          get_wasm_exception_fun = fetch_typed_fun(@llvm_mod, "llvm.wasm.get.exception") do
            LLVM::Type.function([catch_pad.type], llvm_context.void_pointer, false)
          end
          unwind_ex_obj = call get_wasm_exception_fun, [catch_pad]

          get_exception_fun = main_fun(GET_EXCEPTION_NAME)
          get_exception_arg_type = get_exception_fun.type.params_types.first # LibUnwind::Exception*
          get_exception_arg = pointer_cast(unwind_ex_obj, get_exception_arg_type)

          set_current_debug_location node if @debug.line_numbers?
          caught_exception_ptr = call get_exception_fun, [get_exception_arg]
          caught_exception = int2ptr caught_exception_ptr, llvm_typer.type_id_pointer
          exception_type_id = load llvm_context.int32, caught_exception
        else
          # Allocate space for the caught exception
          caught_exception_ptr = alloca exception_llvm_type

          # The catchpad instruction dictates which types of exceptions this block handles,
          # we want all of them, so we rescue all void* by passing the void_ptr_type_descriptor.
          # We also need to record the catch pad instruction in `@catch_pad` to refer to the parent catch
          # pad in nested rescue blocks, and to generate funclet information for function calls which are
          # "inside" this catchpad. More information on this is available in the link above.
          @catch_pad = builder.catch_pad catch_switch, [void_ptr_type_descriptor, int32(0), caught_exception_ptr]

          # builder.printf("catchpad entered #{node.location}\\n", catch_pad: @catch_pad)

          caught_exception = load exception_llvm_type, caught_exception_ptr
          exception_type_id = type_id(caught_exception, exception_type)
        end
      else"""

# The ensure re-raise catchpad (exceptions raised inside a `rescue` body). Same
# wasm shape as above; it never reads the exception, only re-raises it, so it
# needs no catch-object slot at all.
CODEGEN_ENSURE_OLD = """        if msvc
          rescue_ensure_body = new_block "rescue_ensure_body"
          catch_switch = builder.catch_switch(old_catch_pad || LLVM::Value.null, @rescue_block || LLVM::BasicBlock.null, 1)
          builder.add_handler catch_switch, rescue_ensure_body

          position_at_end rescue_ensure_body

          @catch_pad = builder.catch_pad catch_switch, [void_ptr_type_descriptor, int32(0), llvm_context.void_pointer.null]"""

CODEGEN_ENSURE_NEW = """        if funclet_eh
          rescue_ensure_body = new_block "rescue_ensure_body"
          catch_switch = builder.catch_switch(old_catch_pad || LLVM::Value.null, @rescue_block || LLVM::BasicBlock.null, 1)
          builder.add_handler catch_switch, rescue_ensure_body

          position_at_end rescue_ensure_body

          if wasm_target
            # As in the rescue pad: a wasm catchpad takes a single catch-all
            # operand, and a re-raise needs no catch-object slot.
            @catch_pad = builder.catch_pad catch_switch, [llvm_context.void_pointer.null]
          else
            @catch_pad = builder.catch_pad catch_switch, [void_ptr_type_descriptor, int32(0), llvm_context.void_pointer.null]
          end"""

# The re-raise itself. `codegen_re_raise` must branch on the *same* predicate as
# its caller (`funclet_eh`), or on wasm the caller enters the funclet path
# (leaving `unwind_ex_obj` nil) while the callee takes the non-funclet path and
# asserts on it. msvc re-raises with `_CxxThrowException`; the wasm analogue is
# LLVM's `llvm.wasm.rethrow` intrinsic, which rethrows the exception caught by the
# nearest enclosing catch -- both call sites sit inside a catchpad.
CODEGEN_RERAISE_OLD = """  def codegen_re_raise(node, unwind_ex_obj)
    if @program.has_flag?("msvc")
      # On the MSVC C++ ABI we can re-raise by calling _CxxThrowException with two null arguments
      call windows_throw_fun, [llvm_context.void_pointer.null, llvm_context.void_pointer.null]
      unreachable
    else"""

CODEGEN_RERAISE_NEW = """  def codegen_re_raise(node, unwind_ex_obj)
    if @program.target_machine.triple.starts_with?("wasm32")
      # WebAssembly has no _CxxThrowException. Its re-raise is LLVM's
      # llvm.wasm.rethrow intrinsic, which rethrows the exception caught by the
      # nearest enclosing catch. Both call sites above sit inside a catchpad, so
      # this re-raises exactly the exception being handled.
      rethrow_fun = fetch_typed_fun(@llvm_mod, "llvm.wasm.rethrow") do
        LLVM::Type.function([] of LLVM::Type, llvm_context.void, false)
      end
      call rethrow_fun
      unreachable
    elsif @program.has_flag?("msvc")
      # On the MSVC C++ ABI we can re-raise by calling _CxxThrowException with two null arguments
      call windows_throw_fun, [llvm_context.void_pointer.null, llvm_context.void_pointer.null]
      unreachable
    else"""

# The wasm personality declaration (see PERSONALITY_SET above).
WASM_PERSONALITY_FUN_OLD = """  private def windows_personality_fun
    fetch_typed_fun(@llvm_mod, "__CxxFrameHandler3") do
      LLVM::Type.function([] of LLVM::Type, @llvm_context.int32, true)
    end
  end
end"""

WASM_PERSONALITY_FUN_NEW = """  private def windows_personality_fun
    fetch_typed_fun(@llvm_mod, "__CxxFrameHandler3") do
      LLVM::Type.function([] of LLVM::Type, @llvm_context.int32, true)
    end
  end

  # WasmEHPrepare requires a scoped personality on every function that owns a
  # catchpad; libc++abi provides this one. It is never called directly -- the VM's
  # unwinder and _Unwind_CallPersonality drive it -- but it must be declared.
  private def wasm_personality_fun
    fetch_typed_fun(@llvm_mod, "__gxx_wasm_personality_v0") do
      LLVM::Type.function([] of LLVM::Type, @llvm_context.int32, true)
    end
  end
end"""

# The main module's personality (the per-function one is set in exception.cr).
CODEGEN_PERSONALITY_OLD = """      if @program.has_flag?("msvc")
        @personality_name = "__CxxFrameHandler3"
        @main.personality_function = windows_personality_fun.func
      else
        @personality_name = "__crystal_personality"
      end"""

CODEGEN_PERSONALITY_NEW = """      if @program.has_flag?("msvc")
        @personality_name = "__CxxFrameHandler3"
        @main.personality_function = windows_personality_fun.func
      elsif @program.target_machine.triple.starts_with?("wasm32")
        # WebAssembly EH uses libc++abi's scoped wasm personality, which
        # WasmEHPrepare requires on every function that owns a catchpad.
        @personality_name = "__gxx_wasm_personality_v0"
        @main.personality_function = wasm_personality_fun.func
      else
        @personality_name = "__crystal_personality"
      end"""

# The one thing the C API cannot set: WebAssembly's *exception model*. It is
# chosen by the LLVM `cl::opt` `-wasm-enable-eh` (WebAssemblyMCAsmInfo.cpp:53,
# WebAssemblyTargetMachine.cpp:430), which clang's `-fwasm-exceptions` also sets.
# With it unset the wasm target machine reports `ExceptionHandling::None`, so
# TargetPassConfig runs the `lowerinvoke` pass -- which converts every `invoke`
# to a `call` and deletes the `catchswitch`/`catchpad` -- and the exception
# escapes the module no matter how correct the funclet IR is. `--mattr`
# (`+exception-handling`) only toggles the subtarget feature; it does not select
# the model. So the frontend has to flip the option itself, once, after the wasm
# target is initialized (so the option is registered) and before the target
# machine's MCAsmInfo is built. This lives in a compiler file (not llvm.cr)
# because the bootstrap resolves `require "llvm"` against the *installed*
# distribution, which would not carry the edit.
CODEGEN_TARGET_EH_INIT_OLD = """    when "wasm32"
      LLVM.init_webassembly
    else"""

CODEGEN_TARGET_EH_INIT_NEW = """    when "wasm32"
      LLVM.init_webassembly
      # The wasm exception model is an LLVM `cl::opt` the C API cannot set, and
      # the subtarget feature must agree or `try`/`catch` cannot be selected; so
      # a wasm target always gets both. See enable_wasm_eh.
      enable_wasm_eh
      features += "+exception-handling" unless features.includes?("exception-handling")
    else"""

CODEGEN_TARGET_EH_METHOD_OLD = """    environment == other.environment
  end
end"""

CODEGEN_TARGET_EH_METHOD_NEW = """    environment == other.environment
  end

  @@wasm_eh_enabled = false

  # Turns on WebAssembly exception handling in the wasm backend, and picks the
  # proposal the whole module will use.
  #
  # The exception model is selected by an LLVM `cl::opt` (`-wasm-enable-eh`) that
  # is not reachable through the LLVM C API. Without it the wasm backend runs the
  # `lowerinvoke` pass and silently discards every `try`/`catch`, so a raised
  # exception escapes the module instead of being caught. clang's
  # `-fwasm-exceptions` sets the very same option. Idempotent: the option parser
  # is only meant to run once per process.
  private def enable_wasm_eh : Nil
    return if @@wasm_eh_enabled
    @@wasm_eh_enabled = true

    # `-wasm-use-legacy-eh=false` is the second half, and it is not optional.
    # LLVM 20 defaults to the *legacy* proposal (`try`/`catch`/`rethrow`) while
    # wasi-sdk's libc++ is built with the standardized one (`try_table`/
    # `throw_ref`) -- and a module may not contain both: V8 rejects a mix at
    # validation, which a lazily-compiled module hides until something forces a
    # full validation. So everything is emitted for the standardized proposal,
    # which is also the one LLVM's own comment says browsers are moving to.
    #
    # LLVMParseCommandLineOptions skips argv[0], hence the leading "crystal".
    LLVM.parse_command_line_options([
      "crystal",
      "-wasm-enable-eh",
      "-wasm-use-legacy-eh=false",
    ])
  end
end"""

# `_Unwind_SetIP` is declared as returning `LibC::SizeT`, but the Itanium ABI -- and
# every real libunwind, including the wasm build in wasi-sdk -- declares it `void`. That
# is why wasm-ld says "function signature mismatch: _Unwind_SetIP ... defined as
# (i32, i32) -> i32 in out.o.wasm, defined as (i32, i32) -> void in libunwind.a": the
# binding is wrong about the return type, on every platform, not just wasm. Crystal never
# uses the result (`raise.cr` calls it as a statement), so correcting the declaration
# removes the warning and the mismatched declaration from the emitted IR.
UNWIND_SET_IP_OLD = "    fun set_ip = _Unwind_SetIP(context : Context, ip : LibC::SizeT) : LibC::SizeT"
UNWIND_SET_IP_NEW = "    fun set_ip = _Unwind_SetIP(context : Context, ip : LibC::SizeT) : Void"

# (relative path, old, new, marker) -- marker is a string present only in the
# patched file, needed when `old` survives inside `new` (pure insertions), so that
# a second run recognises the patch as applied instead of applying it again.
# `Process#initialize` calls `Crystal::System::Process.prepare_args` and hands the
# result to `spawn`. 1.22 dropped the WASI `prepare_args` stub that 1.17 had while
# the caller kept using it, and left WASI's `spawn` with the pre-1.22 nine-argument
# shape (`command, args, shell, ...`) where the caller now passes eight
# (`prepared_args, shell, ...`). The compiler reaches `Process` through
# `Process.run` (see `config.cr`), so this has to typecheck. `spawn` is
# unimplemented on WASI either way; the signatures only have to agree.
WASI_PREPARE_ARGS_OLD = """  def self.spawn(command, args, shell, env, clear_env, input, output, error, chdir)
    raise NotImplementedError.new("Process.spawn")
  end"""

WASI_PREPARE_ARGS_NEW = """  def self.prepare_args(command, args, shell)
    raise NotImplementedError.new("Process.prepare_args")
  end

  def self.spawn(prepared_args, shell, env, clear_env, input, output, error, chdir)
    raise NotImplementedError.new("Process.spawn")
  end"""

# `wasi/file_descriptor.cr` requires the unix implementation and then redefines
# `system_lock`. Its override is written with untyped parameters, which does *not*
# replace unix's `(blocking : Bool, exclusive : Bool) : Nil` -- it is a separate
# overload, so a `Bool` call still picks the unix body, which names
# `LibC::FlockOp` (absent on WASI). Matching the signature makes the WASI override
# win, and the unix body is never compiled.
WASI_SYSTEM_LOCK_OLD = """  private def system_lock(blocking, exclusive)
    raise NotImplementedError.new "Crystal::System::File#system_lock"
  end"""

WASI_SYSTEM_LOCK_NEW = """  private def system_lock(blocking : Bool, exclusive : Bool) : Nil
    raise NotImplementedError.new "Crystal::System::File#system_lock"
  end"""

PATCHES = [
    ("compiler/crystal/tools/doc.cr", DOCS_SHIM_OLD, DOCS_SHIM_NEW, "{% skip_file if flag?(:without_docs) %}"),
    ("compiler/crystal/command/docs.cr", DOCS_CMD_OLD, DOCS_CMD_NEW, "{% skip_file if flag?(:without_docs) %}"),
    ("compiler/crystal/command.cr", DISPATCH_OLD, DISPATCH_NEW, None),
    ("compiler/crystal/ffi/lib_ffi.cr", FFI_ABI_OLD, FFI_ABI_NEW, "wasm32 is ILP32, like i386-unix"),
    ("process/status.cr", STATUS_SIGNAL_OLD, STATUS_SIGNAL_NEW, None),
    ("compiler/crystal/config.cr", EXEC_PATH_OLD, EXEC_PATH_NEW, None),
    ("crystal/event_loop/wasi.cr", WASI_OPEN_OLD, WASI_OPEN_NEW, None),
    ("crystal/system/wasi/process.cr", WASI_PREPARE_ARGS_OLD, WASI_PREPARE_ARGS_NEW, "Process.prepare_args"),
    ("crystal/system/wasi/file_descriptor.cr", WASI_SYSTEM_LOCK_OLD, WASI_SYSTEM_LOCK_NEW, None),
    ("raise.cr", WASM_RAISE_STUBS_OLD, WASM_RAISE_STUBS_NEW, None),
    ("raise.cr", WASM_RAISE_UNLESS_OLD, WASM_RAISE_UNLESS_NEW, None),
    ("raise.cr", WASM_RAISE_DEF_OLD, WASM_RAISE_DEF_NEW, None),
    ("raise.cr", WASM_RAISE_DEF_END_OLD, WASM_RAISE_DEF_END_NEW, None),
    ("raise.cr", RAISE_REQUIRE_OLD, RAISE_REQUIRE_NEW, '{% unless flag?(:interpreted) %}\n  require "exception/lib_unwind"\n{% end %}'),
    ("exception/call_stack/null.cr", NULL_BACKTRACE_OLD, NULL_BACKTRACE_NEW, "def self.print_backtrace : Nil"),
    ("exception/lib_unwind.cr", UNWIND_SET_IP_OLD, UNWIND_SET_IP_NEW, None),
    ("compiler/crystal/codegen/exception.cr", MSVC_BRANCH_OLD, MSVC_BRANCH_NEW, "funclet_eh = msvc || wasm_target"),
    ("compiler/crystal/codegen/exception.cr", PERSONALITY_SET_OLD, PERSONALITY_SET_NEW, None),
    ("compiler/crystal/codegen/exception.cr", CODEGEN_RESCUE_OLD, CODEGEN_RESCUE_NEW, None),
    ("compiler/crystal/codegen/exception.cr", CODEGEN_ENSURE_OLD, CODEGEN_ENSURE_NEW, None),
    ("compiler/crystal/codegen/exception.cr", CODEGEN_RERAISE_OLD, CODEGEN_RERAISE_NEW, None),
    ("compiler/crystal/codegen/exception.cr", WASM_PERSONALITY_FUN_OLD, WASM_PERSONALITY_FUN_NEW, None),
    ("compiler/crystal/codegen/codegen.cr", CODEGEN_PERSONALITY_OLD, CODEGEN_PERSONALITY_NEW, None),
    ("compiler/crystal/codegen/target.cr", CODEGEN_TARGET_EH_INIT_OLD, CODEGEN_TARGET_EH_INIT_NEW, None),
    ("compiler/crystal/codegen/target.cr", CODEGEN_TARGET_EH_METHOD_OLD, CODEGEN_TARGET_EH_METHOD_NEW, None),
]

PATCHES += GC_PATCHES


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    root = pathlib.Path(sys.argv[1])
    if not (root / "compiler/crystal.cr").is_file():
        print(f"not a Crystal source tree: {root}", file=sys.stderr)
        return 2

    for rel, old, new, marker in PATCHES:
        path = root / rel
        text = path.read_text()
        # Decide "already applied" carefully: when the replacement contains the
        # original (an insertion), `old` survives inside `new`, so looking for
        # `old` cannot mean "not applied" -- those patches carry an explicit
        # marker. Otherwise both the old-absent/new-present states are enough.
        if marker is not None:
            already = marker in text
        else:
            already = new in text and old not in text
        if already:
            print(f"already applied: {rel}")
        elif old in text:
            path.write_text(text.replace(old, new, 1))
            print(f"patched: {rel}")
        elif new in text:
            print(f"already applied: {rel}")
        else:
            print(f"PATCH TARGET CHANGED, cannot apply: {rel}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
