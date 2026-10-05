#!/usr/bin/env python3
"""Reference implementation of the tool definition hash, version 1.

Written from docs/TOOL_DEFINITION_HASH.md, independently of mcp-pin's
JavaScript, with the Python standard library only. Run it to check the
published test vectors:

    python3 docs/tool_definition_hash.py [docs/tool-definition-hash-vectors.json]
"""
import decimal
import hashlib
import json
import math
import os
import re
import sys

_SURROGATE = re.compile('[\ud800-\udfff]')


class NoCanonicalForm(ValueError):
    pass


def _no_repeats(pairs):
    out = {}
    for name, value in pairs:
        if name in out:
            raise NoCanonicalForm('repeated member name')
        out[name] = value
    return out


def _no_constant(name):
    raise NoCanonicalForm(name + ' is not JSON')


def parse(text):
    """JSON text to values, the way RFC 8785 sees it: every number is an
    IEEE 754 double, and a repeated member name is an error."""
    return json.loads(
        text,
        object_pairs_hook=_no_repeats,
        parse_int=lambda s: float(int(s)),
        parse_float=float,
        parse_constant=_no_constant,
    )


def _number(x):
    # ECMA-262 Number::toString, which RFC 8785 section 3.2.2.3 requires.
    if x != x or math.isinf(x):
        raise NoCanonicalForm('NaN and Infinity are not JSON')
    if x == 0:
        return '0'
    if x < 0:
        return '-' + _number(-x)
    _, digits, exp = decimal.Decimal(repr(x)).as_tuple()  # repr: the shortest digits that round-trip
    s = ''.join(map(str, digits))
    t = s.rstrip('0')
    exp += len(s) - len(t)
    s, k = t, len(t)
    n = k + exp
    if k <= n <= 21:
        return s + '0' * (n - k)
    if 0 < n <= 21:
        return s[:n] + '.' + s[n:]
    if -6 < n <= 0:
        return '0.' + '0' * -n + s
    e = n - 1
    return s[0] + ('.' + s[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e))


_SHORT = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r'}


def _string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if ch in _SHORT:
            out.append(_SHORT[ch])
        elif c < 0x20 or 0xD800 <= c <= 0xDFFF:
            out.append('\\u%04x' % c)  # lone surrogates as JSON.stringify writes them
        else:
            out.append(ch)
    out.append('"')
    return ''.join(out)


def canonical(value):
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, list):
        return '[' + ','.join(canonical(v) for v in value) + ']'
    if isinstance(value, dict):
        names = sorted(value, key=lambda n: n.encode('utf-16-be', 'surrogatepass'))
        return '{' + ','.join(_string(n) + ':' + canonical(value[n]) for n in names) + '}'
    raise NoCanonicalForm('not a JSON value: %r' % (value,))


def _utf8(s):
    # An unpaired surrogate is encoded as U+FFFD, as the WHATWG encoder does.
    return _SURROGATE.sub('�', s).encode('utf-8')


def sha256(s):
    return hashlib.sha256(_utf8(s)).hexdigest()


def definition_hash(definition):
    return sha256(canonical(definition))


def set_lines(definitions):
    rows = []
    for d in definitions:
        name = d.get('name') if isinstance(d, dict) else None
        if not isinstance(name, str):
            raise NoCanonicalForm('a definition has no string name')
        rows.append((name, definition_hash(d)))
    rows.sort(key=lambda r: (r[0].encode('utf-16-be', 'surrogatepass'), r[1]))
    return [name + ':' + h for name, h in rows]


def set_hash(definitions):
    return sha256('\n'.join(set_lines(definitions)))


def instructions_hash(text):
    return None if text is None else sha256(text)


def check(path):
    with open(path, encoding='utf-8') as f:
        v = json.load(f)
    bad = 0

    def report(ok, about):
        nonlocal bad
        bad += 0 if ok else 1
        print(('ok    ' if ok else 'FAIL  ') + about)

    for d in v['definitions']:
        c = canonical(parse(d['input']))
        report(c == d['canonical'] and sha256(c) == d['hash'], d['about'])
    for s in v['sets']:
        defs = [x for page in s['pages'] for x in parse(page)]
        report(set_lines(defs) == s['lines'] and set_hash(defs) == s['setHash'], s['about'])
    for i in v['instructions']:
        report(instructions_hash(i['instructions']) == i['hash'], i['about'])
    for x in v['invalid']:
        try:
            if 'input' in x:
                canonical(parse(x['input']))
            else:
                set_hash([d for page in x['pages'] for d in parse(page)])
            report(False, x['about'])
        except NoCanonicalForm:
            report(True, x['about'])
    return bad


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    sys.exit(1 if check(sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'tool-definition-hash-vectors.json')) else 0)
