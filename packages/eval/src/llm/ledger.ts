/**
 * The LLM budget, checked **before** each call rather than after.
 *
 * A ledger that notices it has overspent is not a budget — amendment 75, paid for once
 * already in the ASR runner, where `spent >= budget` permitted the call that crossed the
 * ceiling and refused only the next one.
 *
 * The projection here is the mean cost of the calls made so far, and it is honest about what
 * that can and cannot do: the first call of a run is unprojectable, so the ceiling is one call
 * late exactly once, and after that the estimate is good to the extent segments are similar in
 * length — they are one FLEURS sentence each. The ASR path projects from clip duration against
 * a known per-minute rate; there is no equivalent until `rates` carries LLM token units, so
 * the weaker form is used and named rather than dressed up as the stronger one.
 */
export class BudgetExhausted extends Error {
  constructor() {
    super('budget exhausted');
    this.name = 'BudgetExhausted';
  }
}

export class Ledger {
  spent = 0;
  exhausted = false;
  private calls = 0;

  constructor(private readonly limit: number | null) {}

  /** Throws `BudgetExhausted` rather than returning false: there is no safe way to continue. */
  checkBefore(): void {
    if (this.limit === null) return;
    const projected = this.calls === 0 ? 0 : this.spent / this.calls;
    if (this.spent + projected > this.limit || this.spent >= this.limit) {
      this.exhausted = true;
      throw new BudgetExhausted();
    }
  }

  add(usd: number): void {
    this.spent += usd;
    this.calls++;
  }
}
