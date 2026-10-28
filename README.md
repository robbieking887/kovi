# Kovi

Vehicle walkaround checks for fleets. Drivers check a vehicle on their phone, the office sees every check, defects and alerts.

## Status
`demo/kovi-fleet.html` is a clickable single-file demo (driver app plus office dashboard). GPS, compass, signal and email are simulated. The real build is next.

## How it works
- **Drivers** sign in with name and PIN, pick or scan a vehicle, and work through the checklist: plate photo, licence/CPC, mileage, pass/defect per item, photos for defects, declarations, submit.
- **Proof the check was done:** the phone must stay within 50 m of the vehicle (GPS), sweep all four sides (compass), and spend the minimum time on each locked page. Anything that fails is flagged and the office is emailed.
- **Offline:** checks save on the phone and send when signal returns.
- **Office** sees the fleet board, alerts, drivers, can edit the checklist and page lock times, and marks defects as fixed.

## Pricing
- 1 pound per vehicle per week, same for every vehicle type.
- Any week started is a full week (7-day blocks from the day a vehicle is added), so one day on the account costs 1 pound.
- Invoiced monthly in arrears from the units on the account. Checks, drivers and office users are free.
- Vehicles can be added or removed at any time.

## Planned stack
Next.js web app (driver app as an installable PWA), Supabase (database, auth, storage), Stripe (monthly invoicing), email alerts.
