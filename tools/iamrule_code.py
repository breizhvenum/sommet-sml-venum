#!/usr/bin/env python3
"""Read and patch the code section of a compiled App-Zone rule (IAMRULE ver 8) — used to add a
backlight flash to native guided workouts, which the compiler never emits.

Layout after the header's dataOffset: u16 n_out, u16 n_builtin, u16 n_slots, n_slots x 12-byte slot
records, u16 data-memory size, u16 pool size, pool, u16 code length, code. The code is padded to an
even length with one 0x00 after the final `end`.

Instructions are variable length (table below). Jumps (jz/jmp/onerr) carry a u16 offset relative to
the jump's own start, forward only. A native call is `21 <id u16> <0 u16> <argc u16>`:
0x1b = Suunto.alarmBeep(), 0x1c = Suunto.light(). A JSON-compiled guided workout is a fixed
interpreter over a per-step table; it calls native 0x27 to show each new step (and the finish
screen) on the guidance display — the natural place for a light flash.

`splice()` was checked byte-exact against the live compiler's own output (inserting/removing
alarmBeep/light calls, even and odd lengths, both directions) — see test_iamrule_code.py.

    ./tools/iamrule_code.py compiled.bin            # disassemble (.bin, or .json with "binary")
"""
import json
import struct
import sys

OP_LEN = {
    **dict.fromkeys((0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
                     0x0e, 0x13, 0x18, 0x19, 0x1f), 1),
    0x10: 2,
    **dict.fromkeys((0x0d, 0x12, 0x14, 0x15, 0x16, 0x1c, 0x50, 0x54, 0x55, 0x59), 3),
    0x1b: 5, 0x90: 5,
    0x21: 7,
}
OP_NAME = {0x00: "pad", 0x01: "add", 0x02: "sub", 0x03: "mul", 0x04: "div", 0x05: "lt",
           0x06: "le", 0x07: "gt", 0x08: "ge", 0x09: "eq", 0x0a: "ne", 0x0b: "and", 0x0c: "or",
           0x0e: "not", 0x13: "errh", 0x18: "strend", 0x19: "strbeg", 0x1f: "end",
           0x10: "pushb", 0x0d: "jmp", 0x12: "onerr", 0x14: "load", 0x15: "store", 0x16: "jz",
           0x1c: "isinv", 0x50: "pushw", 0x54: "aload", 0x55: "astore", 0x59: "setstr",
           0x1b: "arrcpy", 0x90: "pushf", 0x21: "call"}
JUMPS = (0x0d, 0x12, 0x16)
END = 0x1f

CALL_BEEP = 0x1b
CALL_LIGHT = 0x1c
CALL_GUIDANCE_DISPLAY = 0x27


def call_bytes(call_id, argc=0):
    return struct.pack("<BHHH", 0x21, call_id, 0, argc)


def layout(binary):
    if binary[:8] != b"IAMRULE\0":
        raise ValueError("not an IAMRULE binary")
    data_offset = struct.unpack_from("<I", binary, 24)[0]
    n_out, n_builtin, n_slots = struct.unpack_from("<HHH", binary, data_offset)
    records_end = data_offset + 6 + n_slots * 12
    _mem_size, pool_size = struct.unpack_from("<HH", binary, records_end)
    code_len_pos = records_end + 4 + pool_size
    code_len = struct.unpack_from("<H", binary, code_len_pos)[0]
    code = code_len_pos + 2
    if code + code_len != len(binary):
        raise ValueError(f"code section ({code}+{code_len}) does not end at EOF ({len(binary)})")
    return {"code_len_pos": code_len_pos, "code": code, "code_len": code_len}


def instructions(binary):
    """[(offset_in_code, opcode, raw_bytes)] for the whole code section; raises on an unknown
    opcode or if decoding doesn't end exactly at the end of the code."""
    lay = layout(binary)
    code = binary[lay["code"]:]
    out, pc = [], 0
    while pc < len(code):
        op = code[pc]
        n = OP_LEN.get(op)
        if n is None or pc + n > len(code):
            raise ValueError(f"unknown/truncated opcode 0x{op:02x} at code+{pc}")
        out.append((pc, op, code[pc:pc + n]))
        pc += n
    return out


def jump_target(ins):
    pc, _op, raw = ins
    return pc + struct.unpack_from("<H", raw, 1)[0]


def validate(binary):
    """Structural check: full decode, every jump lands on an instruction start, ends with `end`."""
    ins = instructions(binary)
    starts = {pc for pc, _, _ in ins}
    for i in ins:
        if i[1] in JUMPS and jump_target(i) not in starts:
            raise ValueError(f"jump at code+{i[0]} -> {jump_target(i)} is not an instruction start")
    tail = [i for i in ins if i[1] != 0x00]
    if not tail or tail[-1][1] != END:
        raise ValueError("code does not end with `end`")
    return ins


def splice(binary, pos, delete=0, insert=b""):
    """Replace `delete` bytes at code offset `pos` (an instruction start) with `insert`, shifting
    every jump that crosses the edit, rewriting the code length and the even-length pad. A jump
    that targets `pos` exactly keeps targeting it, i.e. it now lands on the inserted bytes."""
    lay = layout(binary)
    ins = validate(binary)
    starts = {pc for pc, _, _ in ins}
    code = bytearray(binary[lay["code"]:])
    if code[-1] == 0x00 and len(code) >= 2 and code[-2] == END:
        del code[-1]
    if pos not in starts or pos >= len(code):
        raise ValueError(f"code+{pos} is not an instruction start")
    delta = len(insert) - delete
    for i in ins:
        pc, op, _ = i
        if op not in JUMPS:
            continue
        tgt = jump_target(i)
        if pos <= pc < pos + delete:
            if tgt <= pos + delete:
                continue   # a jump that stays inside the removed block goes with it
            raise ValueError(f"jump at code+{pc} leaves the deleted range")
        if pos < tgt < pos + delete:
            raise ValueError(f"jump at code+{pc} lands inside the deleted range")
        if pc < pos < tgt or (delete and pc < pos and tgt == pos + delete):
            new_off = tgt + delta - pc
            if not 0 < new_off <= 0xFFFF:
                raise ValueError("jump offset out of range")
            struct.pack_into("<H", code, pc + 1, new_off)
    code[pos:pos + delete] = insert
    if len(code) % 2:
        code.append(0x00)
    out = binary[:lay["code_len_pos"]] + struct.pack("<H", len(code)) + bytes(code)
    validate(out)
    return out


def call_sites(binary, call_id):
    return [pc for pc, op, raw in instructions(binary)
            if op == 0x21 and struct.unpack_from("<H", raw, 1)[0] == call_id]


CALL_LOAD_STEP = 0x29


def light_if_step(slot, steps, total):
    """`if (slot == s1 || slot == s2 ...) Suunto.light();` in the compiler's own encoding (load,
    push, eq per value, `or` between, jz over the call). Unconditional when every step is chosen,
    empty when none is."""
    steps = sorted(set(steps))
    if not steps:
        return b""
    if steps == list(range(total)):
        return call_bytes(CALL_LIGHT)
    cond = b""
    for k, s in enumerate(steps):
        cond += struct.pack("<BHBfB", 0x14, slot, 0x90, float(s), 0x09)
        if k:
            cond += b"\x0c"
    light = call_bytes(CALL_LIGHT)
    return cond + struct.pack("<BH", 0x16, 3 + len(light)) + light


def guidance_sites(binary):
    """Where a guided workout (JSON-compiled template) shows things, as code offsets:
    step counter slot + number of steps it runs (the repeat-expanded sequence), the display call
    for each new step, the finish-screen display call, and the out-of-limits alarm beep."""
    ins = instructions(binary)
    loads = [k for k, (_, op, raw) in enumerate(ins)
             if op == 0x21 and struct.unpack_from("<H", raw, 1)[0] == CALL_LOAD_STEP
             and ins[k - 2][1] == 0x14 and ins[k - 1][1] == 0x90]
    displays = [k for k, (_, op, raw) in enumerate(ins)
                if op == 0x21 and struct.unpack_from("<H", raw, 1)[0] == CALL_GUIDANCE_DISPLAY]
    beeps = [k for k, (_, op, raw) in enumerate(ins)
             if op == 0x21 and struct.unpack_from("<H", raw, 1)[0] == CALL_BEEP]
    if len(loads) != 1 or len(displays) != 2 or len(beeps) > 1:
        raise ValueError("not the guided-workout template this code knows")
    k = loads[0]
    slot = struct.unpack_from("<H", ins[k - 2][2], 1)[0]
    total = struct.unpack_from("<f", ins[k - 1][2], 1)[0]
    advance = [struct.pack("<BH", 0x14, slot), struct.pack("<Bf", 0x90, 1.0), b"\x01",
               struct.pack("<BH", 0x15, slot)]
    if not any([i[2] for i in ins[j:j + 4]] == advance for j in range(len(ins) - 3)):
        raise ValueError("step counter slot not recognised")
    step_display = next((d for d in displays if d > k), None)
    finish_display = next((d for d in displays if d != step_display), None)
    if step_display is None or finish_display is None or total != int(total):
        raise ValueError("guidance display calls not where expected")
    return {"slot": slot, "total": int(total),
            "step_start": ins[step_display + 1][0], "finish": ins[finish_display + 1][0],
            "limits": ins[beeps[0]][0] if beeps else None,
            "jump_targets": {jump_target(i) for i in ins if i[1] in JUMPS}}


def add_lights(binary, on_step_start=(), on_limits=(), on_finish=True, expected_total=None):
    """Guided workout + backlight: flash when each step in `on_step_start` begins (right after its
    display update), together with the out-of-limits alarm for steps in `on_limits`, and on the
    finish screen. Steps are 0-based positions in the repeat-expanded sequence (a step inside a
    3x repeat appears 3 times). `expected_total` = length of that sequence from the workout JSON;
    must match the template's own step count. Returns (binary, flashes_added)."""
    if call_sites(binary, CALL_LIGHT):
        return binary, 0   # already patched - idempotent
    g = guidance_sites(binary)
    if expected_total is not None and expected_total != g["total"]:
        raise ValueError(f"workout has {expected_total} steps, binary runs {g['total']}")
    edits = [(g["step_start"], light_if_step(g["slot"], on_step_start, g["total"]))]
    if on_finish:
        edits.append((g["finish"], call_bytes(CALL_LIGHT)))
    if on_limits:
        if g["limits"] is None:
            raise ValueError("no out-of-limits alarm in this binary")
        edits.append((g["limits"], light_if_step(g["slot"], on_limits, g["total"])))
    edits = [(pos, block) for pos, block in edits if block]
    for pos, _ in edits:
        if pos in g["jump_targets"]:
            # another path lands here; inserting would flash on that path too - refuse, not guess
            raise ValueError(f"insertion point code+{pos} is a jump target")
    out = binary
    for pos, block in sorted(edits, reverse=True):   # back to front: earlier offsets stay valid
        out = splice(out, pos, insert=block)
    return out, len(edits)


def add_light_on_step_change(binary):
    """Light at every step start and at the finish (all steps chosen)."""
    return add_lights(binary, on_step_start=range(guidance_sites(binary)["total"]))


SLOT_OPS_U16 = (0x14, 0x15, 0x1c, 0x59, 0x54, 0x55)   # load store isinv setstr aload astore
BUILTIN_DAYS_AFTER_2000 = 0x33   # SUUNTO_DAYS_AFTER_1_1_2000's builtin id (compiler output, 2026-10-10)
MEM_TYPES = (0x04, 0x20)          # slot types whose 5th field is a data-memory offset (floats/arrays, strings)

# Which arguments of a native call are REFERENCES (`pushw slot; pushw length` - the firmware's
# call handler turns the slot word into the slot's address, FUN_0004fc84). Seen in the watch
# program's own interpreter running compiled workouts in the emulator (tools/emu, 2026-10-15):
# the handler converts exactly these stack slots. A native with arguments and no entry here
# makes add_date_gate refuse, rather than leave a reference pointing one slot too low.
NATIVE_REF_ARGS = {
    0x1b: (), 0x1c: (),
    0x25: (True, True, False),                      # (text ref, text ref, value)
    0x26: (False, False, True),                     # (value, value, array ref)
    0x27: (False,) * 8 + (True,),                   # show step: 8 values + text ref
    0x28: (False, True),                            # (value, text ref)
    0x29: (False, True, True, True, True, True, False, False),   # load step: 5 refs
}
# net stack effect of the opcodes a native argument expression is built from
ARG_STACK_EFFECT = {0x90: 1, 0x50: 1, 0x10: 1, 0x14: 1, 0x1c: 1, 0x54: 0, 0x0e: 0,
                    **dict.fromkeys(range(0x01, 0x0d), -1)}


def native_ref_sites(binary):
    """[(code offset of the `pushw slot` of each reference argument, slot)] for every native
    call. Walks each call's arguments backwards: a reference is the pair `pushw slot; pushw
    length`, a value is the shortest instruction run with a net stack effect of +1."""
    ins = instructions(binary)
    sites = []
    for c, (pc, op, raw) in enumerate(ins):
        if op != 0x21:
            continue
        nid, _b, argc = struct.unpack_from("<HHH", raw, 1)
        sig = NATIVE_REF_ARGS.get(nid)
        if sig is None:
            if argc:
                raise ValueError(f"native 0x{nid:02x} at code+{pc}: argument layout not known")
            continue
        if len(sig) != argc:
            raise ValueError(f"native 0x{nid:02x} at code+{pc}: {argc} args, expected {len(sig)}")
        i = c - 1
        for is_ref in reversed(sig):
            if is_ref:
                if not (i >= 1 and ins[i][1] == 0x50 and ins[i - 1][1] == 0x50):
                    raise ValueError(f"native 0x{nid:02x} at code+{pc}: reference argument is not "
                                     "`pushw slot; pushw length`")
                sites.append((ins[i - 1][0], struct.unpack_from("<H", ins[i - 1][2], 1)[0]))
                i -= 2
            else:
                need = 1
                while need > 0:
                    if i < 0 or ins[i][1] not in ARG_STACK_EFFECT:
                        raise ValueError(f"native 0x{nid:02x} at code+{pc}: argument expression "
                                         "not understood")
                    need -= ARG_STACK_EFFECT[ins[i][1]]
                    i -= 1
    return sites


def add_date_gate(binary, days):
    """The compiled program, run ONLY on the day the watch's own SUUNTO_DAYS_AFTER_1_1_2000 equals
    `days` (training_plan.date_to_days2000's value): on any other day the first instructions jump
    straight to `end`, so an active rule for a workout on another date does nothing at all - no
    display, no beeps, no step. This is what lets every upcoming workout sit on the watch as an
    active rule at once and the watch pick the day's one by its own clock, no computer needed
    (André, 2026-10-10: "try to have a workaround to work properly without connecting").

    Adds the builtin the way the compiler does (diffed 2026-10-10 against its own output for the
    same source with and without the variable): one more entry in the symbol-offset list, the
    symbol `[u16 id 0x33]["SUUNTO_DAYS_AFTER_1_1_2000\\0"][pad to even]` after the last builtin,
    a (4,1,0,0,mem,0) slot record inserted right after the last builtin slot (index
    1 + n_out + n_builtin), every later data-memory slot moved up 4 bytes and renumbered in the
    code (load/store/isinv/setstr/aload/astore/arrcpy operands, pushb inside strbeg..strend), the
    data-offset and the two packed header offsets moved by the bytes inserted before them. Then
    `load <days>; pushf days; eq; jz -> end` goes in front of the code (the compiler's own
    encoding of `if (SUUNTO_DAYS_AFTER_1_1_2000 == N)`). Raises if the binary already has the
    variable or isn't the shape this understands."""
    if binary[:8] != b"IAMRULE\0":
        raise ValueError("add_date_gate wants the binary with its IAMRULE magic")
    name = b"SUUNTO_DAYS_AFTER_1_1_2000\0"
    if name in binary:
        raise ValueError("binary already reads SUUNTO_DAYS_AFTER_1_1_2000")
    validate(binary)
    lay = layout(binary)
    data_offset = struct.unpack_from("<I", binary, 24)[0]
    packed = struct.unpack_from("<I", binary, 28)[0]
    n_out, n_builtin, n_slots = struct.unpack_from("<HHH", binary, data_offset)
    # symbol-offset list: u16 offsets (from the start of the binary) ending with 0
    offs, p = [], 32
    while True:
        v = struct.unpack_from("<H", binary, p)[0]
        p += 2
        if v == 0:
            break
        offs.append(v)
    if len(offs) != n_out - 1 + n_builtin or (packed & 0xFFFF) != p - 2:
        raise ValueError("symbol table is not the shape this understands")
    entry = struct.pack("<H", BUILTIN_DAYS_AFTER_2000) + name
    if len(entry) % 2:
        entry += b"\0"
    grow_list = 2
    new_offs = [o + grow_list for o in offs] + [data_offset + grow_list]
    head = bytearray(binary[:32])
    struct.pack_into("<I", head, 24, data_offset + grow_list + len(entry))
    struct.pack_into("<I", head, 28, packed + (grow_list << 16) + grow_list)
    table = b"".join(struct.pack("<H", o) for o in new_offs) + b"\0\0" + binary[p:data_offset] + entry

    k = 1 + n_out + n_builtin
    recs = [list(struct.unpack_from("<HHHHHH", binary, data_offset + 6 + 12 * i)) for i in range(n_slots)]
    if recs[k][0] not in MEM_TYPES:
        raise ValueError(f"slot {k} after the builtins is not a data-memory slot")
    mem_at = recs[k][4]
    for r in recs:
        if r[0] in MEM_TYPES and r[4] >= mem_at:
            r[4] += 4
    recs.insert(k, [4, 1, 0, 0, mem_at, 0])
    records_end = data_offset + 6 + n_slots * 12
    mem_size, pool_size = struct.unpack_from("<HH", binary, records_end)
    pool = binary[records_end + 4:records_end + 4 + pool_size]
    records = struct.pack("<HHH", n_out, n_builtin + 1, n_slots + 1) \
        + b"".join(struct.pack("<HHHHHH", *r) for r in recs) \
        + struct.pack("<HH", mem_size + 4, pool_size) + pool

    # code: renumber slots >= k, then the gate in front
    code = bytearray(binary[lay["code"]:lay["code"] + lay["code_len"]])
    for pos, slot in native_ref_sites(binary):    # `pushw slot` references the natives take
        if slot >= k:
            struct.pack_into("<H", code, pos + 1, slot + 1)
    in_str = False
    for pc, op, raw in instructions(binary):
        if op == 0x19:
            in_str = True
        elif op == 0x18:
            in_str = False
        elif op in SLOT_OPS_U16:
            s = struct.unpack_from("<H", code, pc + 1)[0]
            if s >= k:
                struct.pack_into("<H", code, pc + 1, s + 1)
        elif op == 0x1b:
            a, b = struct.unpack_from("<HH", code, pc + 1)
            struct.pack_into("<HH", code, pc + 1, a + (a >= k), b + (b >= k))
        elif op == 0x10 and in_str and code[pc + 1] >= k:
            code[pc + 1] += 1
    renumbered = bytes(head) + table + records + struct.pack("<H", len(code)) + bytes(code)
    ins = validate(renumbered)
    end_pc = [i for i in ins if i[1] == END][-1][0]
    gate = struct.pack("<BH", 0x14, k) + struct.pack("<Bf", 0x90, float(days)) + b"\x09"
    gate += struct.pack("<BH", 0x16, len(gate) + 3 + end_pc - len(gate))
    return splice(renumbered, 0, insert=gate)


def builtin_slots(binary):
    """{builtin name: slot} - the compiler numbers slot 0, the outputs, then the builtins in the
    order of the symbol list (outputs' names first, then builtins', each `[u16 id][name\\0]`)."""
    data_offset = struct.unpack_from("<I", binary, 24)[0]
    n_out, n_builtin, _ = struct.unpack_from("<HHH", binary, data_offset)
    offs, p = [], 32
    while True:
        v = struct.unpack_from("<H", binary, p)[0]
        p += 2
        if v == 0:
            break
        offs.append(v)
    names = [binary[o + 2:binary.index(b"\0", o + 2)].decode("ascii") for o in offs[n_out - 1:]]
    if len(names) != n_builtin:
        raise ValueError("symbol table is not the shape this understands")
    return {n: 1 + n_out + i for i, n in enumerate(names)}


def _hr_sites(binary):
    """(guard, reads, skip_to) for SUUNTO_HR in a guided workout, or None if it reads no HR.
    guard = code offset of the `isinv hr` in the compiler's entry check (`isinv a; isinv b; or;
    ...; jz run; jmp end`), always followed by an `or`; reads = offsets of every other `load hr`;
    skip_to = where the out-of-limits block ends (the furthest target of a `jz` between the HR
    read and the alarm beep that jumps past the beep) - the HR is used for nothing else."""
    slot = builtin_slots(binary).get("SUUNTO_HR")
    if slot is None:
        return None
    ins = instructions(binary)
    first_onerr = next(k for k, i in enumerate(ins) if i[1] == 0x12)
    guard = [k for k in range(first_onerr) if ins[k][1] == 0x1c
             and struct.unpack_from("<H", ins[k][2], 1)[0] == slot]
    reads = [k for k, i in enumerate(ins) if i[1] == 0x14 and struct.unpack_from("<H", i[2], 1)[0] == slot]
    beep = guidance_sites(binary)["limits"]
    if beep is None or not reads:
        raise ValueError("reads SUUNTO_HR but has no out-of-limits alarm")
    jumps_past = [i for i in ins if i[1] == 0x16 and reads[0] < i[0] < beep < jump_target(i)]
    if not jumps_past or any(i[0] >= beep for i in (ins[k] for k in reads)):
        raise ValueError("SUUNTO_HR is used somewhere this code does not know")
    return ([ins[k][0] for k in guard if ins[k - 1][1] in (0x1c, 0x0c) and ins[k + 1][1] == 0x0c],
            [ins[k][0] for k in reads], max(jump_target(i) for i in jumps_past))


def tolerate_missing_hr(binary):
    """The guided workout runs without a heart rate. The compiler's entry check skips the WHOLE
    program on any tick where one of its inputs is invalid, and a workout with HR targets reads
    SUUNTO_HR - so with no belt (or a dry one) no step screen, no step timing, no beeps: on
    André's Peak 2026-10-14 the day's W7 never showed in "Running workout" with no belt on, while
    the same workout without HR targets ran. HR feeds only the out-of-limits alarm, so: HR leaves
    the entry check, and every `load hr` gets `isinv hr; jz +6; jmp <end of the alarm block>` in
    front - no HR = no zone alarm, everything else as compiled. Idempotent; a binary without
    SUUNTO_HR comes back unchanged. Returns (binary, patched)."""
    sites = _hr_sites(binary)
    if sites is None:
        return binary, False
    guard, reads, skip_to = sites
    slot = builtin_slots(binary)["SUUNTO_HR"]
    ins = instructions(binary)
    if not guard and all(any(i[0] == r - 9 and i[1] == 0x1c for i in ins) for r in reads):
        return binary, False   # already patched
    if len(guard) != 1:
        raise ValueError("SUUNTO_HR entry check not where expected")
    out = binary
    for r in sorted(reads, reverse=True):      # back to front: earlier offsets stay valid
        jmp_at = r + 6
        test = struct.pack("<BH", 0x1c, slot) + struct.pack("<BH", 0x16, 6) \
            + struct.pack("<BH", 0x0d, skip_to + 9 - jmp_at)
        out = splice(out, r, insert=test)
        skip_to += 9
    out = splice(out, guard[0], delete=4)      # `isinv hr; or`
    return out, True


def needs_regate(binary):
    """True for a date-gated workout whose native references still point one slot too low:
    add_date_gate did not renumber `pushw` references until 2026-10-15. On the watch such a
    workout loads no step data: every step ends after one second and the step pop-up never
    shows (André's Peak, 2026-10-14). Checked on the slot records: a reference (slot, length)
    to an array or string must name a slot of that length."""
    if date_gate_days(binary) is None:
        return False
    data_offset = struct.unpack_from("<I", binary, 24)[0]
    n_slots = struct.unpack_from("<H", binary, data_offset + 4)[0]
    recs = [struct.unpack_from("<HHHHHH", binary, data_offset + 6 + 12 * i) for i in range(n_slots)]
    ins = instructions(binary)
    by_pos = {pc: raw for pc, _op, raw in ins}
    for pos, slot in native_ref_sites(binary):
        length = struct.unpack_from("<H", by_pos[pos + 3], 1)[0]
        if slot + 1 < n_slots and recs[slot][1] != length and recs[slot + 1][1] == length:
            return True
    return False


def date_gate_days(binary):
    """The day value an add_date_gate() binary runs on, or None if it starts with no such gate.
    Lets a sync spot a workout gated on the wrong day (the 2026-09-02..10-14 off-by-one, see
    training_plan.FIRMWARE_DAYS_OFFSET) instead of keeping it."""
    ins = instructions(binary)
    if len(ins) >= 4 and [i[1] for i in ins[:4]] == [0x14, 0x90, 0x09, 0x16]:
        return int(struct.unpack_from("<f", ins[1][2], 1)[0])
    return None


def disassemble(binary):
    lines = []
    for pc, op, raw in instructions(binary):
        name, arg = OP_NAME.get(op, f"op{op:02x}"), ""
        if op == 0x90:
            arg = f"{struct.unpack_from('<f', raw, 1)[0]:g}"
        elif op == 0x21:
            cid, _b, argc = struct.unpack_from("<HHH", raw, 1)
            arg = {CALL_BEEP: "alarmBeep", CALL_LIGHT: "light"}.get(cid, f"native 0x{cid:02x}")
            arg += f" argc={argc}"
        elif op == 0x1b:
            arg = "%d <- %d" % struct.unpack_from("<HH", raw, 1)
        elif op == 0x10:
            arg = str(raw[1])
        elif len(raw) == 3:
            v = struct.unpack_from("<H", raw, 1)[0]
            arg = f"-> {pc + v}" if op in JUMPS else str(v)
        lines.append(f"{pc:5d}  {raw.hex(' '):22s} {name:7s} {arg}")
    return "\n".join(lines)


def _load(path):
    if path.endswith(".json"):
        return bytes(json.load(open(path))["binary"])
    return open(path, "rb").read()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    print(disassemble(_load(sys.argv[1])))
