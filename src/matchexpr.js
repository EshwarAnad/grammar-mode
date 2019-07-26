function escRe(str) {
  return str.replace(/[^\w ¡-￿]/g, ch => {
    if (ch == "\n") return "\\n"
    if (ch == "\t") return "\\t"
    if (ch == "\r") return "\\r"
    return "\\" + ch
  })
}

function toSubRegexp(expr, wrapExpr) {
  if (expr.regexpPrec < wrapExpr.regexpPrec) return `(?:${expr.toRegexp()})`
  else return expr.toRegexp()
}

const OP_SEQ = 0, OP_CHOICE = 1,
      OP_STAR = 2, OP_PLUS = 3, OP_MAYBE = 4,
      OP_LOOKAHEAD = 5, OP_NEG_LOOKAHEAD = 6,
      OP_PREDICATE = 7

class MatchExpr {
  constructor() {}

  get isNull() { return false }
  get simple() { return true }
  get isolated() { return false }

  get regexpPrec() { return 4 }

  toExpr() {
    return `/^${toSubRegexp(this, SeqMatch.prototype)}/`
  }

  forEach(f) { f(this) }
}

class StringMatch extends MatchExpr {
  constructor(string) {
    super()
    this.string = string
  }

  get simple() { return this.string != "\n" }
  get isolated() { return !this.simple }

  eq(other) { return other instanceof StringMatch && other.string == this.string }

  toRegexp() { return escRe(this.string) }

  get regexpPrec() { return this.string.length == 1 ? super.regexpPrec : 2 }

  toExpr() { return JSON.stringify(this.string) }
}
exports.StringMatch = StringMatch

class RangeMatch extends MatchExpr {
  constructor(from, to) {
    super()
    this.from = from
    this.to = to
  }

  get simple() { return this.from > "\n" || this.to < "\n" }
  get isolated() { return !this.simple }

  eq(other) { return other instanceof RangeMatch && other.from == this.from && other.to == this.to }

  toRegexp() { return "[" + escRe(this.from) + "-" + escRe(this.to) + "]" }
}
exports.RangeMatch = RangeMatch

const anyMatch = exports.anyMatch = new class AnyMatch extends MatchExpr {
  get simple() { return false }
  get isolated() { return true }
  eq(other) { return other == anyMatch }
  toRegexp() { return "[^]" }
}

const dotMatch = exports.dotMatch = new class DotMatch extends MatchExpr {
  eq(other) { return other == dotMatch }
  toRegexp() { return "." }
}

const nullMatch = exports.nullMatch = new class NullMatch extends MatchExpr {
  get isNull() { return true }
  eq(other) { return other == anyMatch }
  toRegexp() { return "" }
  toExpr() { return "null" }
}

class SeqMatch extends MatchExpr {
  constructor(matches) {
    super()
    this.matches = matches
  }

  eq(other) { return other instanceof SeqMatch && eqArray(other.matches, this.matches) }

  get simple() {
    return this.matches.every(m => m.simple)
  }
  get isolated() {
    return this.matches.some(m => m.isolated)
  }

  get regexpPrec() { return 2 }

  toRegexp() { return this.matches.map(m => toSubRegexp(m, this)).join("") }

  toExpr(getName) {
    if (this.simple) return super.toExpr()
    return `[${OP_SEQ}, ${this.matches.map(m => m.toExpr(getName)).join(", ")}]`
  }

  forEach(f) { f(this); this.matches.forEach(m => m.forEach(f)) }

  static create(left, right) {
    if (left == nullMatch) return right
    if (right == nullMatch) return left

    let before = left instanceof SeqMatch ? left.matches : [left]
    let after = right instanceof SeqMatch ? right.matches : [right]
    let last = before[before.length - 1], first = after[0]

    if (last instanceof StringMatch && first instanceof StringMatch) {
      after[0] = new StringMatch(last.string + right.string)
      before.pop()
    } else if (first instanceof RepeatMatch && first.type == "*") {
      if (last.eq(first.match)) {
        after[0] = new RepeatMatch(last, "+")
        before.pop()
      } else if (first.match instanceof StringMatch && last instanceof StringMatch &&
                 new RegExp(first.match.toRegexp() + "$").test(last.string)) {
        after[0] = new RepeatMatch(first.match, "+")
        before[before.length - 1] = new StringMatch(last.string.slice(0, last.string.length - first.match.string.length))
      }
    }
    let matches = before.concat(after)
    return matches.length == 1 ? matches[0] : new SeqMatch(matches)
  }
}
exports.SeqMatch = SeqMatch

class ChoiceMatch extends MatchExpr {
  constructor(matches) {
    super()
    this.matches = matches
  }

  get simple() { return this.matches.every(m => m.simple) }

  get isolated() { return this.matches.some(m => m.isolated) }

  eq(other) { return other instanceof ChoiceMatch && eqArray(other.matches, this.matches) }

  get regexpPrec() { return this.isSet() ? 4 : 1 }

  isSet() {
    return this.matches.every(m => m instanceof StringMatch && m.string.length == 1 || m instanceof RangeMatch)
  }

  // FIXME reduce to \d, \w when appropriate
  toRegexp() {
    if (this.isSet())
      return `[${this.matches.map(m => m instanceof StringMatch ? escRe(m.string) : escRe(m.from) + "-" + escRe(m.to)).join("")}]`
    else
      return this.matches.map(m => toSubRegexp(m, this)).join("|")
  }

  toExpr(getName) {
    if (this.simple) return super.toExpr()
    return `[${OP_CHOICE}, ${this.matches.map(m => m.toExpr(getName)).join(", ")}]`
  }

  forEach(f) { f(this); this.matches.forEach(m => m.forEach(f)) }

  static create(left, right) {
    let matches = []
    if (left instanceof ChoiceMatch) matches = matches.concat(left.matches)
    else matches.push(left)
    if (right instanceof ChoiceMatch) matches = matches.concat(right.matches)
    else matches.push(right)
    return new ChoiceMatch(matches)
  }
}
exports.ChoiceMatch = ChoiceMatch

class RepeatMatch extends MatchExpr {
  constructor(match, type) {
    super()
    this.match = match
    this.type = type
  }

  get simple() { return this.match.simple }

  eq(other) { return other instanceof RepeatMatch && this.match.eq(other.match) && this.type == other.type }

  get regexpPrec() { return 3 }

  toRegexp() {
    return toSubRegexp(this.match, this) + this.type
  }

  toExpr(getName) {
    if (this.simple) return super.toExpr()
    return `[${this.type == "*" ? OP_STAR : this.type == "+" ? OP_PLUS : OP_MAYBE}, ${this.match.toExpr(getName)}]`
  }

  forEach(f) { f(this); this.match.forEach(f) }
}
exports.RepeatMatch = RepeatMatch

class LookaheadMatch extends MatchExpr {
  constructor(start, expr, positive) {
    super()
    this.start = start
    this.expr = expr
    this.positive = positive
  }

  get isNull() { return true }

  get simple() { return !!this.expr }

  eq(other) {
    return other instanceof LookaheadMatch && other.start == this.start &&
      (this.expr ? other.expr && this.expr.eq(other.expr) : !other.expr) &&
      other.positive == this.positive
  }

  toRegexp() {
    if (this.expr)
      return `(?${this.positive ? "=" : "!"}${this.expr.toRegexp()})`
    else // Not actually a regexp, but used for graph output
      return "LOOKAHEAD(" + this.start + ")"
  }

  toExpr(getName) {
    if (this.expr) return super.toExpr()
    return `[${this.positive ? OP_LOOKAHEAD : OP_NEG_LOOKAHEAD}, ${getName(this.start.name)}]`
  }

  forEach(f) { f(this); if (this.expr) this.expr.forEach(f) }
}
exports.LookaheadMatch = LookaheadMatch

class PredicateMatch extends MatchExpr {
  constructor(name) {
    super()
    this.name = name
  }

  get isNull() { return true }

  get simple() { return false }

  eq(other) { return other instanceof PredicateMatch && other.name == this.name }

  toRegexp() { return "PRED(" + this.name + ")" }

  toExpr() {
    return `[${OP_PREDICATE}, ${JSON.stringify(this.name)}]`
  }
}
exports.PredicateMatch = PredicateMatch

let eqArray = exports.eqArray = function(a, b) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}
