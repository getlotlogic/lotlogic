// ── Truck plaza default policy template ──────────────────────
// This copy is what actually reaches drivers: it is persisted into
// properties.policy_text on truck-plaza create/save, and visit.html prefers
// policy_text over its own fallback constant. Keep in sync with the matching
// constant in frontend/visit.html AND with any existing policy_text rows.
export const DEFAULT_TRUCK_PLAZA_POLICY = `TRUCK PARKING POLICIES

1. DROPPED TRAILERS — No dropped trailers.
2. DESIGNATED PARKING ONLY — Parking is permitted only in designated parking spaces. Parking is prohibited beside the store, around the CAT Scale, around the gas drop location, beside the diesel drop location, beside the white air hose building, parallel to the driveway, blocking trash dumpsters, and in employee parking areas (Employee Parking Only).
3. NO CONSECUTIVE PARKING AFTER 48 HOURS — Trucks registered for 24–48 hours must vacate the property after their stay. Once you leave the premises, you must wait at least 24 hours before returning to park. NO EXCEPTIONS.
4. VEHICLE WASHING — Trailer or truck washing is prohibited on the property.
5. PERSONAL VEHICLES — Personal vehicles are not permitted in truck parking or employee parking areas.
6. DIESEL FUEL ISLAND — Sleeping on the diesel fuel island is prohibited.
7. TRUCK REGISTRATION REQUIREMENT — All trucks must enter their full license plate number and full company name when checking in. Failure to provide complete and accurate information will be considered a violation of these parking policies. Trucks with incomplete or incorrect registration information are subject to immediate towing at the owner's expense.

TOWING ENFORCED — Violation of any of the above parking policies will result in towing at the vehicle owner's expense. Property management has authorized the property's tow operator to enforce these parking policies.

LIABILITY NOTICE — The property and tow operator are not liable for any damage to trucks, trailers, or personal vehicles occurring on the property or resulting from towing. By registering, you agree to follow all parking policies and understand this liability notice.`;
