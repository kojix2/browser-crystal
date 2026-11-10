"""GC changes shared by source builds and the packaged standard library.

The compiler keeps emitting objects; the JavaScript host owns the final link and
GC instrumentation. These patches do not enable GC in the compiler itself.
"""
import json
from pathlib import Path

DEPENDENCIES = json.loads((Path(__file__).with_name("gc-dependencies.json")).read_text())
GC_VERSION = DEPENDENCIES["bdwgc"]["version"]

GC_PATCHES = [
    ("gc.cr", "{% if flag?(:gc_none) || flag?(:wasm32) %}",
     """{% if flag?(:wasm_gc_experimental) && !(flag?(:wasm32) && flag?(:wasi) && flag?(:without_mt)) %}
  {% raise "wasm_gc_experimental requires wasm32-wasi and without_mt" %}
{% end %}
{% if flag?(:gc_none) || (flag?(:wasm32) && !flag?(:wasm_gc_experimental)) %}""", None),
    ("gc/boehm.cr", "flag?(:android) || (flag?(:interpreted)",
     "flag?(:android) || flag?(:wasi) || (flag?(:interpreted)", None),
    ("gc/boehm.cr", "{% if flag?(:freebsd) || flag?(:dragonfly) %}",
     """{% if flag?(:wasi) %}
  # The host supplies the pinned WASI archive; no pkg-config subprocess exists.
  @[Link("gc")]
{% elsif flag?(:freebsd) || flag?(:dragonfly) %}""", None),
    ("gc/boehm.cr", "  {% unless flag?(:win32) %}\n    {% pkg_config_name",
     f'  {{% if flag?(:wasi) %}}\n    VERSION = "{GC_VERSION}"\n  {{% elsif !flag?(:win32) %}}\n    {{% pkg_config_name', None),
    ("gc/boehm.cr", "fun get_prof_stats = GC_get_prof_stats(stats : ProfStats*, size : SizeT)",
     "fun get_prof_stats = GC_get_prof_stats(stats : ProfStats*, size : SizeT) : SizeT",
     "fun get_prof_stats = GC_get_prof_stats(stats : ProfStats*, size : SizeT) : SizeT"),
    ("gc/boehm.cr", "fun get_start_callback = GC_get_start_callback : Void*",
     "fun get_start_callback = GC_get_start_callback : ->", None),
    ("gc/boehm.cr", "fun set_stackbottom = GC_set_stackbottom(th : ThreadHandle, sb : StackBase*) : ThreadHandle",
     "fun set_stackbottom = GC_set_stackbottom(th : ThreadHandle, sb : StackBase*)", None),
]


def patch_stdlib(files):
    """Patch a path -> source map, refusing drift just like apply-patches.py."""
    for rel, old, new, marker in GC_PATCHES:
        text = files[rel]
        if (marker and marker in text) or (new in text and old not in text):
            continue
        if text.count(old) != 1:
            raise ValueError(f"GC PATCH TARGET CHANGED: {rel}")
        files[rel] = text.replace(old, new, 1)
    return files
