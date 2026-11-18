# Legal and compliance heads-ups (draft)

Status: Proposed, needs owner approval.

Refs #50. **The legal list below has not been reviewed by a lawyer.** Neither the triggers, the wording, nor which
information is refused should ship until one has reviewed them. Schmeide is not giving legal advice and neither is
this document.

## Levels

- **Note**: Schmeide has handled it, or it is worth knowing. The person does nothing.
- **Check**: only the person can confirm it. They tick a statement; who, when, and the exact wording are recorded.
- **Can't build**: not allowed, or not supported. The person picks one of the alternatives offered.

Level is always shown as a word and an icon, never by color alone.

## Draft triggers

Wording is calm and plain, one or two sentences, with no legal terms and no blame. Every entry says what Schmeide will
do. Entries marked **Undecided** need an owner decision before wording is final.

### 1. Names an existing product as the model ("like QuickBooks") (Note)

- Says: "We'll build your own app with the same kinds of features. We don't copy the other product's name,
  logo, wording, or look."
- Instead: Carries on with their own app

### 2. Gives the address or screenshots of their own site or system (Check)

- Says: "This is mine, or I have the right to rebuild it."
- Instead: Uses its name, logo, colors, and wording once ticked

### 3. Gives the address or screenshots of someone else's site or app (Note)

- Says: "We use this to understand what you like about it. Its text, pictures, and layout are not copied."
- Instead: Asks what they like about it

### 4. Asks for an exact copy of someone else's site or app (Can't build)

- Says: "We can't make a copy of someone else's site or app."
- Instead: "Tell us what you like about it"

### 5. Uploads a picture that shows other people's personal details (Note)

- Says: "We read this to understand the layout. The personal details are not put into your app."
- Instead: Carries on without the details

### 6. Uploads a logo, pictures, or text (Check)

- Says: "I own these, or I have permission to use them."
- Instead: Builds without them if not ticked

### 7. Brings their own information over from another tool (Note)

- Says: "Your information is yours to move."
- Instead: Imports from a file they upload

### 8. Wants to collect information from someone else's site or service without permission (Can't build)

- Says: "We can't collect from a site or service unless it allows it."
- Instead: Upload a file, or connect only where the service allows it

### 9. Uses another company's name in the app's name or address (**Undecided:** Check or Can't build)

- Says: "Using another company's name can mislead people."
- Instead: A name of their own; a Check if the company is theirs

### 10. Wants to pass as another business, or get around a payment or licence (Can't build)

- Says: "We can't build this. See our Acceptable Use page."
- Instead: The app under their own name

### 11. Stores customers' personal details (Note)

- Says: "We'll add a privacy notice page to your app, and it says where the information is stored."
- Instead: Adds the page

### 12. Wants to store card numbers (Can't build)

- Says: "Your app can't store card numbers."
- Instead: A payment provider handles cards

### 13. Wants to store health records, children's details, or government ID numbers (**Undecided**)

- Says: Not written until decided.
- Instead: Not decided: refuse, or allow with a Check.

### 14. Sends marketing email or texts (Note)

- Says: "We'll put an unsubscribe link in every message."
- Instead: Adds the link

The standing line under every heads-up: "This is general information, not legal advice", linking to the Acceptable Use
page (#68).

## Where they appear

- Beside the plan item that caused them (#49), so the layout decision in [interview-layout.md](interview-layout.md)
  must leave room for a heads-up under an item.
- On "Here's what we read" after a picture or address (#70).
- Collected under "Before you approve" (#51); every Check must be ticked before the build starts.
- On change requests after launch (#54).
- Confirmed Checks listed in #56.

## What a Check records

The person's account, the time, and the exact words they saw. A reworded statement is a new Check, so older
confirmations still point at what was actually shown.

## Needs from the server

- A check run on every interview answer, upload, and change request that returns heads-ups.
- Stored confirmations (who, when, wording).
- A list of refused and flagged requests for an operator to review.

## Not decided

- The trigger list and its wording, pending a lawyer. Triggers 9 and 13 have an open choice.
- Which sensitive information is refused, rather than allowed with a Check.
- What happens after repeated refusals (a warning, a pause, an operator review).
- Whether a Check can be reworded per locale. This sits beside the Commercial Terms item in #5.
