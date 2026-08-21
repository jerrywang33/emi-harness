# EMI Safeguarding: Funds Received for Issued Electronic Money

## Use Boundary

This context is an EEA source baseline for a prospective electronic money institution. It does not determine the home Member State, licence scope, safeguarding method, national transposition, competent-authority expectations, or whether a specific balance is in scope. Those points require task-level Human Authority confirmation before they become TRD facts.

## Source-Supported Controls

### SG-001: Safeguarding obligation

EMD2 Article 7(1) requires an electronic money institution to safeguard funds received in exchange for electronic money that has been issued. A design handling those funds must identify when the obligation attaches and preserve a traceable link between the received funds and the corresponding issued electronic money.

### SG-002: Payment-instrument timing boundary

For funds received by payment instrument, EMD2 Article 7(1) describes when safeguarding may begin and sets an outer boundary of no later than five business days after issuance. A system must not invent its own calendar, availability event, or deadline rule; the confirmed jurisdictional interpretation and business calendar must be explicit inputs.

### SG-003: Segregation or alternative safeguarding path

PSD2 Article 10 describes safeguarding paths for relevant payment-service-user funds. Under the segregation path, the source text addresses non-commingling, transfer by the end of the following business day to a separate account or eligible assets when funds remain held, and insulation under national law against other creditors. The selected method and its application to an EMI's specific funds require home-state confirmation.

### SG-004: Superseded source references

PSD2 Article 114 states that references to repealed Directive 2007/64/EC are read as references to PSD2 using Annex II. This records the source chain for EMD2 references; it is not a substitute for legal review of national implementation.

## Task Confirmations

- TC-001: Confirm the licensed entity, home Member State, competent authority, product and whether the funds are received in exchange for issued electronic money.
- TC-002: Confirm the safeguarding method, account or eligible-asset arrangement, and national-law insolvency treatment.
- TC-003: Confirm receipt, availability and issuance events, applicable business-day calendar, cut-off rules and deadline calculation.
- TC-004: Confirm treatment of fees, chargebacks, reversals, unsettled card receipts, FX differences, interest and operational discrepancies.
- TC-005: Confirm reconciliation frequency, ownership, escalation thresholds, evidence retention and regulatory reporting obligations.

## Engineering-Derived Design Inputs

These are conservative engineering translations, not independent legal conclusions. They remain subject to TC-001 through TC-005.

- ED-001: Represent fund classification, safeguarding status and relevant event timestamps as explicit domain data rather than deriving them from a generic payment status.
- ED-002: Keep safeguarding balances and movements traceable to immutable ledger entries; do not use mutable aggregate balances as the only evidence.
- ED-003: Make jurisdictional timing and business calendars versioned configuration with effective dates; reject missing configuration instead of applying a silent default.
- ED-004: Produce a reproducible reconciliation result with input cut-off, expected amount, actual amount, variance, disposition, operator and evidence references.
- ED-005: Treat unresolved variance, unknown fund classification and missed safeguarding deadline as explicit blocked or exception states with controlled escalation.

## Agent Rules

- Preserve every TC item as an unresolved TRD item until a Human Authority or approved policy supplies evidence.
- Trace each adopted technical control and test to SG or ED identifiers.
- Do not claim that this context proves compliance, choose a safeguarding method, or resolve Member State law.
- If the task facts fall outside this boundary, stop and request a different or expanded EMI Context.
