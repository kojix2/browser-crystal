GC.max_heap_size = 8_u64 * 1024 * 1024

class KeptByGC
  @@global = "global " + "survivor"

  def self.global
    @@global
  end
end

@[NoInline]
def allocate_garbage
  Bytes.new(65536, 0xAB_u8)
  nil
end

@[NoInline]
def make_closure
  captured = "closure " + "survivor"
  -> { captured }
end

local = "local " + "survivor"
array = ["array " + "survivor"]
hash = {"key" => "hash " + "survivor"}
closure = make_closure
before = GC.prof_stats.gc_no
4096.times { allocate_garbage }
GC.collect
raise "local root lost" unless local == "local survivor"
raise "global root lost" unless KeptByGC.global == "global survivor"
raise "array root lost" unless array[0] == "array survivor"
raise "hash root lost" unless hash["key"] == "hash survivor"
raise "closure root lost" unless closure.call == "closure survivor"
raise "no automatic collections" unless GC.prof_stats.gc_no > before + 1
raise "heap limit exceeded" unless GC.stats.heap_size <= 8_u64 * 1024 * 1024
raise "insufficient allocation" unless GC.stats.total_bytes >= 256_u64 * 1024 * 1024
puts "GC stress PASS"
