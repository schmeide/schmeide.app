# Hearth Bakery (bakery), quick

Model sonnet, owner played by haiku, 2026-11-18.

> I want to take orders from the cafés I supply and from people in the shop.

| Owner  | Questions | Quote an earlier answer | Raise what they did not mention | With a reason | Cost   | Seconds per question |
| ------ | --------- | ----------------------- | ------------------------------- | ------------- | ------ | -------------------- |
| bakery | 10        | 1                       | 1                               | 10            | $0.196 | 5.6                  |

## Questions

### 1. Walk me through one café order today: how does it reach you, and what happens until you're paid?

_Why:_ Knowing how an order really travels shows where the app can save you the most time.

**Answer:** The café sends its order by WhatsApp or email, usually the day before before 2pm. That afternoon I write tomorrow's bake list by hand from the messages, Tom and I bake overnight, and I deliver at 6am in the van. The café isn't billed until the end-of-month invoice, which I make in a spreadsheet, and I'm not sure of their exact payment terms after that.

_3.7s, $0.015_

### 2. Roughly how many partner cafés do you supply, and how many orders or items does a typical day's bake list have?

_Why:_ The size of the daily bake list decides how much work typing in orders and totals would save you.

_Choices:_ Under 5 cafés, a short list / 5 to 15 cafés, a medium list / More than 15 cafés, a long list

**Answer:** 5 to 15 cafés, a medium list

_5.2s, $0.019_

### 3. What do you sell, and do the cafés order the same things most days or does it change a lot?

_Why:_ If cafés have standing orders, the app can pre-fill them and save you retyping the same list daily.

_Choices:_ Mostly the same order every day / Same each week, with some days different / Changes a lot day to day

**Answer:** Same each week, with some days different

_3.9s, $0.017; raises standing orders_

### 4. Which part of this takes the most time or goes wrong most often today?

_Why:_ Fixing the most painful step first saves you the most hours each week.

_Choices:_ Reading WhatsApp and email messages and writing the bake list / Missing or wrong orders that arrive late or unclear / Making the monthly invoices / Chasing cafés for payment

**Answer:** Missing or wrong orders that arrive late or unclear

_7.8s, $0.024_

### 5. When a café's order is late or unclear, what happens now, and what would you want the app to do about it?

_Why:_ Missing or wrong orders are your biggest problem, so the fix should match how you handle them today.

_Choices:_ Bake their usual order anyway / Message the café to check / Leave it out of the bake / Depends on the café

**Answer:** Message the café to check

_3.5s, $0.017; builds on an answer_

### 6. What would you most want to see at a glance first thing each morning?

_Why:_ Knowing what you check first shows what the app should put on its front page.

_Choices:_ Which cafés haven't sent tomorrow's order yet / Tomorrow's full bake list / Today's delivery list / What each café owes so far this month

**Answer:** Today's delivery list

_5.4s, $0.020_

### 7. A café realises at 4pm that they need more croissants tomorrow, after the 2pm close. What should happen?

_Why:_ Late changes are where bake lists and deliveries usually go wrong, and you said late or unclear orders are your biggest problem.

_Choices:_ Refuse it; the order is locked at 2pm / Let them send it, and I decide whether to accept / Accept it automatically but flag it on the bake list / Depends on the café

**Answer:** Let them send it, and I decide whether to accept

_6.5s, $0.021_

### 8. For the end-of-month invoices, which of these do you want the app to do on day one?

_Why:_ Invoices are done in a spreadsheet now, and it's the one step that could stay as it is while the ordering gets fixed first.

_Choices:_ Add up each café's deliveries and make the invoice / Just give me the month's totals per café; I'll still invoice myself / Leave invoicing out for now

**Answer:** Just give me the month's totals per café; I'll still invoice myself

_5.9s, $0.021_

### 9. To total each café's month, the app needs prices. Does every café pay the same price for an item?

_Why:_ Wrong prices in the totals would mean wrong invoices, which costs you money.

_Choices:_ Same price for everyone / Some cafés have their own prices / Prices change from time to time

**Answer:** Some cafés have their own prices

_7.5s, $0.023_

### 10. A café has sent tomorrow's order before 2pm, then wants to cancel or change it. Up to when should they be allowed to do that themselves?

_Why:_ Changes after the bake list is made can mean wasted bakes that cost you money.

_Choices:_ Until 2pm the day before, then they must ask me / Any time until I start baking / Never; they must message me to change it

**Answer:** Until 2pm the day before, then they must ask me

_6.1s, $0.020_

## The plan at the end

- business: Hearth Bakery supplies baked goods to partner cafés and sells to people in its shop.
- does: Take orders from partner cafés.
- does: Take orders from people in the shop.
- does: Collect each café's order for tomorrow, which must arrive before 2pm the day before.
- does: Produce the overnight bake list from all orders received.
- does: Produce a delivery list for the 6am van run.
- rules: Café orders close at 2pm the day before delivery.
- rules: Cafés are billed once a month, not per order; payment terms are not yet known.
- replaces: Café orders arrive by WhatsApp and email today.
- replaces: The bake list is written by hand each afternoon.
- replaces: Monthly invoices are made in a spreadsheet.
- who: The owner and Tom bake overnight; the owner delivers.
- business: There are 5 to 15 partner cafés, and a typical day's bake list is medium-sized.
- does: Keep each café's usual weekly order, so they only change the days that differ.
- business: Café orders are mostly the same each week, with some days different.
- business: The biggest problem today is café orders that arrive late, go missing, or are unclear.
- does: Show which cafés have not yet sent tomorrow's order, so the owner can message them to check.
- screens: The first screen each morning shows today's delivery list.
- does: Let a café send an order after the 2pm close, marked as late for the owner to accept or decline.
- rules: A late order only counts for the bake list and delivery list once the owner accepts it.
- does: Show the month's totals per café, so the owner can invoice from them.
- does: Make the end-of-month invoice for each café. (later)
- rules: The owner still makes the invoices herself in the spreadsheet on day one.
- rules: Some cafés have their own prices for items, so month totals use each café's own prices.
- keeps: Each café's own price for each item.
- rules: A café can change or cancel its own order until 2pm the day before; after that they must ask the owner.
- does: Let a café change or cancel its order itself until the 2pm close.

## Checklist points left open

- rules.mistakes
- rules.exceptions
- people.roles
- people.access
- information.records
- information.existing
- day_one.first
