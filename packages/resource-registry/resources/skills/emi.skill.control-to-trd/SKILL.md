# Control-to-TRD Mapping

Use this Skill only when a versioned PRD and a validated EMI Context are explicit inputs.

## Procedure

1. List every in-scope PRD requirement and every EMI Context statement ID.
2. Preserve each `task_confirmation_required` item as unresolved until an approved evidence reference is provided.
3. For each confirmed control, write the required system behavior, failure behavior, data or state impact, permission boundary and observable evidence.
4. Define at least one deterministic verification method for every adopted control. If deterministic verification is impossible, name the Human Authority, evidence and decision required.
5. Produce a traceability table from PRD and Context IDs to TRD sections, implementation controls, checks and evidence.
6. Mark non-applicable controls with a reason and confirmation reference; never silently omit them.

## Required Output

- TRD content covering inputs, scope, behavior, architecture, data, state, controls, verification, recovery and risks.
- A complete PRD-to-TRD and Context-to-control traceability table.
- A structured list of blocking and non-blocking unresolved items with owner and required evidence.

## Prohibited Actions

- Do not determine legal applicability, select a Member State interpretation or approve a regulatory conclusion.
- Do not convert an unresolved item into an assumption to keep execution moving.
- Do not expand the PRD, tool permissions, repository scope or Run limits.
- Do not claim that a complete document or generated code proves compliance.
