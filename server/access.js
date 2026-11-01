'use strict';
// One place decides whether a company can use Kovi right now.
//   legacy  - existing customers from before the free trial existed (never locked)
//   exempt  - the platform owner switched billing off for this company
//   trial   - inside the 30 day free trial
//   grace   - trial over, no card yet: 7 more days of full use, with warnings
//   locked  - trial + grace over and still no card: sign-in works, checks and data are paused until a card is added
//   active  - a card is on file
const GRACE_DAYS = 7, DAY = 864e5;
function accessOf(co, now = Date.now()) {
  if (!co) return { state: 'legacy', days_left: null };
  const hasCard = !!(co.stripe_customer_id && co.card_last4);
  const base = { has_card: hasCard, card_brand: co.card_brand || null, card_last4: co.card_last4 || null, trial_ends_at: co.trial_ends_at || null };
  if (co.billing_exempt) return { ...base, state: 'exempt', days_left: null };
  if (!co.trial_ends_at) return { ...base, state: hasCard ? 'active' : 'legacy', days_left: null };
  if (hasCard) return { ...base, state: 'active', days_left: null };
  const end = new Date(co.trial_ends_at).getTime();
  if (now < end) return { ...base, state: 'trial', days_left: Math.max(1, Math.ceil((end - now) / DAY)) };
  if (now < end + GRACE_DAYS * DAY) return { ...base, state: 'grace', days_left: Math.max(1, Math.ceil((end + GRACE_DAYS * DAY - now) / DAY)) };
  return { ...base, state: 'locked', days_left: 0 };
}
module.exports = { accessOf, GRACE_DAYS };
