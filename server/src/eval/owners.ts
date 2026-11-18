// Scripted owners for the interview evaluation (`make interview/eval`). Each owner answers from a
// fixed fact sheet, so a change to the interview's prompt can be judged by reading the same owners'
// transcripts side by side. A blind spot is something the owner never brings up but an expert in
// their kind of business would ask about; the keywords spot a question that raises it.

export type BlindSpot = { readonly topic: string; readonly keywords: readonly string[] };

export type Owner = {
  readonly id: string;
  readonly name: string;
  // The first thing they type on the start page.
  readonly need: string;
  readonly facts: string;
  readonly blindSpots: readonly BlindSpot[];
};

const INVOICE_NUMBERS: BlindSpot = {
  topic: "invoice numbering",
  keywords: ["invoice number", "numbering", "numbered", "number your invoices"],
};
const TAX: BlindSpot = { topic: "tax", keywords: ["tax", "vat", "gst"] };
const LATE_PAYERS: BlindSpot = {
  topic: "late payers",
  keywords: ["late pay", "pay late", "overdue", "reminder", "chase", "chasing", "unpaid"],
};
const PART_PAYMENTS: BlindSpot = {
  topic: "deposits and part-payments",
  keywords: ["deposit", "part-payment", "part payment", "partial", "installment", "upfront"],
};

export const OWNERS: readonly Owner[] = [
  {
    id: "plumber",
    name: "Flow Plumbing",
    need: "I need to send invoices and see who has paid.",
    facts: `You run a plumbing business with two employed plumbers, Dan and Priya, and you also go out on jobs yourself.
Customers are homeowners and a few letting agents who look after rented flats.
Work comes in by phone call or text. You write it in a paper diary and decide who goes.
Small jobs (a leak, a blocked drain) are done the same day. Bigger jobs (a new bathroom) get a quote first.
About 25 jobs a week; around 3 of them are big jobs that run over several days.
After a job you write an invoice in a Word template on your laptop in the evening and email it as a PDF.
Dan and Priya text you what they did and the parts they used; you type it up.
Letting agents pay by bank transfer, usually within a month. Homeowners pay by card or transfer.
You check the bank app once a week to see who paid and tick it off in a spreadsheet.
What hurts: typing up invoices at night, forgetting parts on the invoice, not knowing who still owes money.
On Monday morning you would like to see which jobs are booked and who owes you money.
Letting agents sometimes ask for the job to be split across two flats or change what is to be done after you quoted.`,
    blindSpots: [
      INVOICE_NUMBERS,
      TAX,
      LATE_PAYERS,
      PART_PAYMENTS,
      {
        topic: "a job changing after the quote",
        keywords: [
          "change after",
          "changes after",
          "extra work",
          "variation",
          "re-quote",
          "requote",
        ],
      },
    ],
  },
  {
    id: "salon",
    name: "Studio Lumen",
    need: "I want clients to book appointments online.",
    facts: `You own a hair salon with three stylists (you, Mia and Joe) and one junior who washes hair.
Clients are mostly regulars from the neighborhood; some book a cut every six weeks.
Today clients phone or message on Instagram, and you write bookings in a big paper book at the desk.
Services: women's cut, men's cut, color, highlights, blow-dry. Color takes two to three hours.
Each stylist has their own prices; Mia charges more for color.
About 120 appointments a week. Saturdays are full two weeks ahead.
Clients pay at the till by card after the appointment. You keep a tip jar.
What hurts: the phone ringing while you are cutting, double bookings in the book, and gaps in the day nobody fills.
You want to see each stylist's day at a glance.
About five clients a week do not turn up, and color appointments that are missed cost you the most.
Some clients always want the same stylist.`,
    blindSpots: [
      {
        topic: "no-shows",
        keywords: ["no-show", "no show", "does not turn up", "doesn't turn up", "miss", "missed"],
      },
      {
        topic: "cancellation rules",
        keywords: ["cancel", "cancellation", "notice"],
      },
      PART_PAYMENTS,
      {
        topic: "reminders before the appointment",
        keywords: ["reminder", "remind", "text before", "message before"],
      },
      {
        topic: "patch tests for color",
        keywords: ["patch test", "allergy", "skin test"],
      },
    ],
  },
  {
    id: "bakery",
    name: "Hearth Bakery",
    need: "I want to take orders from the cafés I supply and from people in the shop.",
    facts: `You run a bakery with a shop at the front. You bake overnight with one other baker, Tom; two people work the counter.
You sell bread, pastries and cakes in the shop, and you supply eight cafés and two restaurants (wholesale).
Wholesale customers order by WhatsApp or email, usually the day before by 2pm. You deliver at 6am in your van.
Most cafés order nearly the same thing every day, with changes for weekends.
Shop customers order celebration cakes in person or by phone, a week ahead.
You write tomorrow's bake list by hand each afternoon from the messages.
Wholesale customers get a monthly invoice that you make in a spreadsheet at the end of the month.
Wholesale prices are lower than shop prices, and two big cafés have their own agreed prices.
About 400 loaves and 600 pastries a week go to wholesale; the shop sells about the same again.
What hurts: missing an order in WhatsApp, baking too much or too little, and the end-of-month invoice day.
You want the bake list and the delivery list for tomorrow ready by 3pm without counting by hand.`,
    blindSpots: [
      {
        topic: "standing orders",
        keywords: [
          "standing order",
          "same order",
          "repeat",
          "regular order",
          "usual order",
          "every day",
        ],
      },
      {
        topic: "order cut-off times",
        keywords: ["cut-off", "cutoff", "deadline", "too late", "after 2"],
      },
      {
        topic: "allergens and labeling",
        keywords: ["allergen", "allergy", "gluten", "nut", "label"],
      },
      {
        topic: "returns and short deliveries",
        keywords: ["return", "short", "missing item", "credit", "wrong delivery"],
      },
      INVOICE_NUMBERS,
      TAX,
      LATE_PAYERS,
    ],
  },
  {
    id: "bookkeeper",
    name: "Ledger & Co",
    need: "I want my clients to send me their receipts and see what I need from them.",
    facts: `You are a self-employed bookkeeper with one part-time assistant, Sara.
Your clients are about 40 small businesses: tradespeople, a few shops, two cafés.
Each month clients send receipts and bank statements by email, WhatsApp, or a shoebox of paper.
You enter them into the client's accounting software, then send a short monthly report.
Some clients pay you a fixed monthly fee; others pay by the hour.
You keep a spreadsheet of which client has sent what this month, and chase by email.
Sara does data entry for about 15 of the clients.
What hurts: chasing clients for missing paperwork, paperwork arriving all at once at the end of the quarter, and losing track of what came in where.
On Monday you want to see which clients are missing paperwork and what is due this week.
Clients must never see each other's papers.`,
    blindSpots: [
      {
        topic: "filing deadlines",
        keywords: ["deadline", "due date", "quarter end", "year end", "return due", "filing"],
      },
      {
        topic: "keeping papers for years",
        keywords: ["keep for", "how long", "years", "retention", "archive", "delete"],
      },
      {
        topic: "clients with more than one person sending",
        keywords: [
          "more than one person",
          "partner",
          "their staff",
          "who at the client",
          "several people",
        ],
      },
      INVOICE_NUMBERS,
      LATE_PAYERS,
    ],
  },
];
