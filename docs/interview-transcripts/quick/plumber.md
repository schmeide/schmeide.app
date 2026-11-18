# Flow Plumbing (plumber), quick

Model sonnet, owner played by haiku, 2026-11-18.

> I need to send invoices and see who has paid.

| Owner   | Questions | Quote an earlier answer | Raise what they did not mention | With a reason | Cost   | Seconds per question |
| ------- | --------- | ----------------------- | ------------------------------- | ------------- | ------ | -------------------- |
| plumber | 10        | 5                       | 2                               | 10            | $0.197 | 6.0                  |

## Questions

### 1. Tell me about Flow Plumbing: what kind of plumbing work do you do, and who are your customers?

_Why:_ Invoicing differs a lot between homeowners, landlords and building contractors, so I want to start with who pays you.

**Answer:** We're a plumbing business with two plumbers, Dan and Priya, and I go out on jobs too. We do small fixes like leaks and blocked drains, usually the same day, and bigger jobs like new bathrooms, which get a quote first. Our customers are homeowners and a few letting agents who look after rented flats.

_8.6s, $0.018_

### 2. Walk me through a small same-day fix, like a blocked drain: what happens from the phone call until the money is in? Who sends the invoice, and when?

_Why:_ Knowing how a job really ends in payment shows where invoices get late or lost.

**Answer:** A call or text comes in, I write it in my paper diary and send whoever is free, often Dan or Priya, and it's fixed the same day. They text me what they did and the parts they used, and that evening I type up the invoice in my Word template and email it as a PDF, so I send it. Homeowners pay by card or transfer, letting agents by transfer within a month, and I check the bank app once a week and tick off who has paid.

_4.9s, $0.016_

### 3. In a normal week, about how many jobs do you invoice?

_Why:_ It tells me whether typing invoices each evening is a small chore or eats a big part of your week.

_Choices:_ Fewer than 10 / 10 to 20 / 20 to 40 / More than 40

**Answer:** 20 to 40

_7.0s, $0.021_

### 4. What goes wrong or takes the most time today: typing invoices each evening, chasing letting agents who pay late, or checking the bank app once a week?

_Why:_ Knowing the biggest time-waster tells us what the first version must fix.

_Choices:_ Typing up invoices each evening / Chasing late payers / Checking the bank to tick off payments / Collecting job details from texts

**Answer:** Typing up invoices each evening

_3.9s, $0.017; builds on an answer; raises late payers_

### 5. When you open the app on a Monday morning, what do you most want to see at a glance?

_Why:_ You check the bank app once a week, so this shows what the first screen should put in front of you.

_Choices:_ Who still owes me money / Which letting agents are overdue / Jobs done but not yet invoiced / What was paid last week

**Answer:** Who still owes me money

_3.9s, $0.018_

### 6. Plumbers now text you what they did and the parts used. Should Dan and Priya enter that themselves on their phones after each job, or keep texting you?

_Why:_ This decides whether the evening typing disappears or just moves.

_Choices:_ Dan and Priya enter it themselves / They keep texting and I enter it / Start with them texting, change later

**Answer:** Dan and Priya enter it themselves

_4.8s, $0.018; builds on an answer_

### 7. You write each call or text in your paper diary and choose who goes. Should the app take over that step, or stay on paper for now?

_Why:_ The diary is where every job starts, so it decides whether plumbers' job entries begin from a booked job or from scratch.

_Choices:_ App takes over the diary: log the call and who is sent / Keep the paper diary for now / Later, once invoicing works

**Answer:** Keep the paper diary for now

_6.9s, $0.022; builds on an answer_

### 8. For bigger jobs like new bathrooms, you quote first. Should the app write and send quotes, or do you keep doing quotes as you do now?

_Why:_ A quote that turns into an invoice saves retyping, but it is extra work to build.

_Choices:_ App writes and sends quotes too, from day one / Quotes later; keep as now for the first version / Quotes stay as they are; app only does invoices

**Answer:** Quotes later; keep as now for the first version

_7.5s, $0.021; builds on an answer; raises a job changing after the quote_

### 9. Today you check the bank app once a week and tick off who has paid. On day one, should you tick invoices as paid yourself in the app?

_Why:_ Marking payments is what lets you see on Monday who still owes you, so I want to get this step right.

_Choices:_ Yes, I tick them off myself in the app / I'd like it to match bank payments automatically, even if that comes later

**Answer:** Yes, I tick them off myself in the app

_6.6s, $0.022; builds on an answer_

### 10. When you type up an invoice today, how do you work out the price?

_Why:_ Pricing decides how much the app can fill in for you and how much time it saves each evening.

_Choices:_ Call-out fee plus hourly rate plus parts / Fixed price for each kind of job, plus parts / I decide the total each time

**Answer:** I decide the total each time

_6.4s, $0.023_

## The plan at the end

- does: Send invoices to customers.
- does: Show which invoices have been paid and which have not.
- business: Flow Plumbing is a small plumbing business with three people: the owner, Dan and Priya.
- business: Small same-day fixes (leaks, blocked drains) and bigger jobs like new bathrooms that get a quote first.
- business: Customers are homeowners and a few letting agents who manage rented flats.
- who: The owner, Dan and Priya all go out on jobs.
- does: Record what was done and the parts used on each job, entered by the plumber who did it.
- does: Turn a finished job into an invoice and email it to the customer as a PDF.
- rules: Homeowners pay by card or transfer; letting agents pay by transfer within a month.
- replaces: A paper diary for writing down calls and texts and who is sent.
- replaces: A Word invoice template, typed up each evening and emailed as a PDF.
- replaces: The bank app, checked once a week to tick off who has paid.
- business: About 20 to 40 jobs are invoiced in a normal week.
- business: The slowest part today is typing up invoices each evening.
- business: On Monday morning the owner most wants to see who still owes money.
- business: Typing up invoices each evening is the biggest time cost to remove.
- who: Dan and Priya enter what they did and the parts used on their phones after each job.
- who: The owner reviews the job and sends the invoice.
- does: Log incoming calls and texts and who is sent; this stays in the paper diary for now. (later)
- does: Write and send quotes for bigger jobs like new bathrooms; for now quotes are done as today. (later)
- does: Owner ticks an invoice as paid in the app after checking the bank app.
- does: Show the owner a list of unpaid invoices, so Monday starts with who still owes money.
- rules: The owner decides each invoice total by hand when sending; the app does not work out prices.

## Checklist points left open

- rules.money
- rules.changes
- rules.mistakes
- rules.exceptions
- people.roles
- people.access
- information.records
- information.existing
- day_one.first
