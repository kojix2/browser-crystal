@[NoInline]
def stack_position : UInt64
  value = 0_u8
  pointerof(value).address
end

@[NoInline]
def throw_with_gc(message)
  kept = message + " alive"
  GC.collect
  raise kept
end

baseline = stack_position
kept = ["outer " + "alive"]
ensures = 0
1000.times do |i|
  begin
    begin
      throw_with_gc("inner #{i}")
    rescue ex
      GC.collect
      raise "bad exception root" unless ex.message == "inner #{i} alive"
      raise ex
    end
  rescue ex
    GC.collect
    raise "bad rethrow" unless ex.message == "inner #{i} alive"
  ensure
    GC.collect
    ensures += 1
  end
  begin
    GC.collect
  ensure
    ensures += 1
  end
  raise "stack leaked at #{i}: #{baseline} -> #{stack_position}" unless stack_position == baseline
end
raise "outer root lost" unless kept[0] == "outer alive"
raise "ensure skipped" unless ensures == 2000
puts "GC exceptions PASS"
