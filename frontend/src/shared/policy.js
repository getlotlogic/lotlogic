// ── Truck plaza default policy template ──────────────────────
// This copy is what actually reaches drivers: it is persisted into
// properties.policy_text on truck-plaza create/save, and visit.html prefers
// policy_text over this fallback constant when a property has none set yet.
//
// Task 17 (2026-09-07): this is now the ONE copy of this text in the repo.
// Before this, visit.html carried its own (headed, bulleted) copy of this
// policy — the one the driver actually sees and agrees to on the
// registration form — while this file (imported by the dashboard's property
// pages as the operator-facing placeholder/"reset to default" text) carried
// a condensed, single-line-per-rule paraphrase with the same substantive
// rules but different wording (rule 2's prohibited-areas list was a bullet
// list in visit.html vs. one run-on sentence here). Per the brief: the
// driver-facing copy is the legally-operative one, so THIS file's content
// changed to match visit.html's version verbatim, not the other way
// around — visit.html's own copy was deleted and it now imports this
// constant too. The dashboard's placeholder/"reset to default" text for a
// truck-plaza property with no policy_text set changes as a result; see
// task-17-report.md for the full before/after.
export const DEFAULT_TRUCK_PLAZA_POLICY = `TRUCK PARKING POLICIES

1. DROPPED TRAILERS
No dropped trailers.

2. DESIGNATED PARKING ONLY
Parking is permitted only in designated parking spaces. Parking is prohibited in the following areas:
• Beside the store
• Around the CAT Scale
• Around the gas drop location
• Beside the diesel drop location
• Beside the white air hose building
• Parallel to the driveway
• Blocking trash dumpsters
• Employee parking areas (Employee Parking Only)

3. NO CONSECUTIVE PARKING AFTER 48 HOURS
Trucks registered for 24–48 hours must vacate the property after their stay. Once you leave the premises, you must wait at least 24 hours before returning to park. NO EXCEPTIONS.

4. VEHICLE WASHING
Trailer or truck washing is prohibited on the property.

5. PERSONAL VEHICLES
Personal vehicles are not permitted in truck parking or employee parking areas.

6. DIESEL FUEL ISLAND
Sleeping on the diesel fuel island is prohibited.

7. TRUCK REGISTRATION REQUIREMENT
All trucks must enter their full license plate number and full company name when checking in. Failure to provide complete and accurate information will be considered a violation of these parking policies. Trucks with incomplete or incorrect registration information are subject to immediate towing at the owner's expense.

TOWING ENFORCED
Violation of any of the above parking policies will result in towing at the vehicle owner's expense. Property management has authorized the property's tow operator to enforce these parking policies.

LIABILITY NOTICE
The property and tow operator are not liable for any damage to trucks, trailers, or personal vehicles occurring on the property or resulting from towing. By registering, you agree to follow all parking policies and understand this liability notice.`;
