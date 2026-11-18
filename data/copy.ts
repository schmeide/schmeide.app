// Every string that appears on the page lives here. Components import from
// this file; they do not hardcode copy.

// The marketing site. The one place its address is written.
const MARKETING_SITE = "https://schmeide.com";

export const copy = {
  // Addresses outside this app.
  outbound: {
    marketingSite: `${MARKETING_SITE}/`,
    earlyAccess: `${MARKETING_SITE}/#early-access`,
  },
  hero: {
    headline: "Schmeide",
    tagline: "Coming soon.",
  },
  loading: "Loading…",
  siteTitle: "Schmeide",
  pageTitle: (page: string) => `${page} · Schmeide`,
  shell: {
    skip: "Skip to main content",
    logo: "Schmeide",
    menu: "Menu",
    primaryNav: "Main",
    accountNav: "Your account",
    businessLabel: "Business",
    notices: "Notices",
    legalNav: "Legal",
    signIn: "Sign in",
    signOut: "Sign out",
  },
  // The frame around the pages a person arriving from schmeide.com sees before the app shell.
  entry: {
    // Read after the logo, so the logo link says where it goes.
    logoHint: ", back to schmeide.com",
  },
  // The name of each route in utils/routes.ts: its navigation label and its tab title.
  routes: {
    apps: "Apps",
    start: "New app",
    startExisting: "What you have today",
    project: "App",
    projectChanges: "Changes",
    projectSettings: "Settings",
    usage: "Usage",
    billing: "Billing",
    business: "Business",
    account: "Account",
    welcome: "Set up your business",
    admin: "Admin",
    adminBusinesses: "Businesses",
    adminBusiness: "Business",
    adminPeople: "People",
    adminAdmins: "Admins",
    adminProjects: "Hosted apps",
    adminUsage: "Tokens and cost",
    adminAudit: "Audit log",
    help: "Help",
    go: "Continue",
    signIn: "Sign in",
    signUp: "Join Schmeide",
    setPassword: "Set your password",
    terms: "Terms",
    privacy: "Privacy",
    acceptableUse: "Acceptable use",
    report: "Report an app",
  },
  placeholder: "This page is not built yet.",
  admin: {
    intro: "For the people who run Schmeide.",
    sectionsNav: "Admin sections",
  },
  // The banner on every page while an admin views the app as someone.
  impersonation: {
    label: "Viewing as a customer",
    viewing: (name: string, email: string) => `You are viewing Schmeide as ${name} (${email}).`,
    recorded: (admin: string) =>
      `Signed in as ${admin}. What you change is recorded in the audit log. Ends after an hour.`,
    stop: "Stop",
    stopping: "Stopping…",
  },
  viewAs: {
    emailLabel: "Their email",
    reasonLabel: "Reason",
    reasonHint:
      "Why you need to see their account, for example a ticket number. Kept in the audit log.",
    reasonNeeded: "Give a reason before viewing as someone.",
    action: "View as this person",
    starting: "Starting…",
  },
  // The form behind every admin action that changes something: a reason the audit log keeps.
  adminActions: {
    emailLabel: "Email",
    reasonLabel: "Reason",
    reasonHint: "Why, for example a ticket number. Kept in the audit log.",
    reasonNeeded: "Give a reason first.",
    working: "Saving…",
    done: "Done.",
    linkIntro:
      "Send them this link to set a password. It works once, for 7 days, and is not shown again.",
    // Shown instead of linkIntro when a sign-in provider is configured (#147).
    signInLinkIntro:
      "Send them this link to sign in. A provider is on, so they do not need a password.",
  },
  // The search box and paging every admin list shares.
  adminSearch: {
    label: "Search",
    action: "Search",
    more: "Show more",
  },
  businesses: {
    intro: "Every business, newest first.",
    searchHint: "A business name, or the email of someone in it.",
    caption: "Businesses",
    columns: ["Business", "Slug", "State", "Members", "Apps", "Created"],
    empty: "No business matches.",
    create: "Create a business",
    createHint:
      "Its first owner is approved. Someone with no account yet gets a link to set a password; someone with one is its owner at once. The same name and owner again gives back the business already made.",
    nameLabel: "Business name",
    ownerLabel: "First owner's email",
    createAction: "Create",
  },
  // One business, in the admin area.
  business: {
    slug: "Slug",
    created: "Created",
    membersTitle: "Members",
    memberColumns: ["Name", "Email", "Role", "Actions"],
    roles: { owner: "Owner", editor: "Editor" },
    state: "State",
    states: { active: "Active", suspended: "Suspended" },
    stateWhy: (reason: string, when: string) => `${reason} (${when})`,
    suspend: "Suspend this business",
    suspendHint:
      "Its members cannot open it and nothing in it builds. A build already running stops after its current step. Its live apps keep running.",
    suspendAction: "Suspend",
    restore: "Restore this business",
    restoreHint: "Its members can open it and build again.",
    restoreAction: "Restore",
    removeMember: (name: string) => `Remove ${name}`,
    removeMemberHint:
      "They lose this business at once and stay signed in. The last owner cannot be removed.",
    removeMemberAction: "Remove from this business",
    noMembers: "Nobody is in this business.",
    projectsTitle: "Apps",
    projectColumns: ["App", "State"],
    noProjects: "This business has no apps.",
  },
  people: {
    intro: "Everyone with an account, and every approved email, newest first.",
    searchHint: "A name or an email.",
    caption: "People",
    columns: ["Name", "Email", "Businesses", "Approved", "Admin", "Actions"],
    yes: "Yes",
    no: "No",
    empty: "Nobody matches.",
    notSignedIn: "Not signed in yet",
    viewAs: (name: string) => `View as ${name}`,
    removeAccess: (name: string) => `Remove access for ${name}`,
    removeHint:
      "Takes them off the approved list and signs them out everywhere. Their account and apps stay.",
    removeAction: "Remove access",
    restoreAccess: (name: string) => `Give ${name} access again`,
    restoreHint: "Puts them back on the approved list. Everything they had is still there.",
    restoreAction: "Give access",
    approve: "Approve someone new",
    approveHint:
      "They can sign in with Google, Microsoft, or Apple, or set a password with the link shown. They get a business of their own on first sign-in.",
    approveAction: "Approve",
  },
  // Who has the platform admin role.
  admins: {
    intro:
      "The people who run Schmeide and can see every business. The last admin cannot lose the role, and nobody can take away their own.",
    caption: "Admins",
    columns: ["Name", "Email", "State", "Actions"],
    active: "Admin",
    pending: "Admin from their first sign-in",
    grant: "Make someone an admin",
    grantHint:
      "Someone with an account and access is an admin at once. Someone with no account yet is approved, and is an admin from their first sign-in.",
    grantAction: "Make admin",
    revoke: (name: string) => `Take the role from ${name}`,
    revokeHint:
      "They are signed out everywhere, and any view as a customer they have open ends. Their access and businesses stay.",
    revokeAction: "Take the role away",
  },
  // Every hosted project, in the admin area.
  hosting: {
    intro:
      "Every app across businesses, newest first. Each runs as two copies, live and being worked on; what each app takes up counts both, read from the container runtime and the disk as the page opens, and is not kept.",
    searchHint: "An app's name, or its business's name.",
    caption: "Hosted apps",
    columns: [
      "App",
      "Business",
      "State",
      "Ports",
      "Last build",
      "Containers",
      "Memory",
      "CPU",
      "Workspace",
    ],
    ports: (live: number, staging: number) => `${live} live, ${staging} being worked on`,
    neverBuilt: "Never built",
    empty: "No app matches.",
  },
  // What hosted apps take up, on the hosted apps page and a business's page.
  resources: {
    title: "What its apps take up",
    intro:
      "Read from the container runtime and the disk now. Unknown means the runtime or the disk did not answer in time.",
    containers: "Containers running",
    memory: "Memory",
    cpu: "CPU",
    workspace: "Workspace on disk",
    unknown: "unknown",
    reading: "…",
    buildsOff:
      "Builds are off on this server, so no app is hosted here and nothing is read from the container runtime or the disk.",
  },
  // Tokens and cost across businesses, in the admin area.
  usage: {
    intro: "What the model runs used and cost, biggest spenders first.",
    period: "Period",
    from: "From",
    to: "To",
    timezone: "Days run from midnight to midnight UTC, both the first and the last day included.",
    deletedProjects:
      "Deleting an app deletes its usage with it, so these totals leave out apps that no longer exist.",
    empty: "Nothing was used in this period.",
    businessesTitle: "By business",
    businessesCaption: "Usage by business",
    projectsTitle: "By app",
    projectsCaption: "Usage by app",
    modelsTitle: "By model",
    modelsCaption: "Usage by model",
    runKindsTitle: "By kind of run",
    runKindsCaption: "Usage by kind of run",
    timeTitle: "Time by business",
    timeCaption: "Time by business",
    timeNote:
      "A build counts in the period it finished in. Builder time leaves out runs from before it was recorded.",
    failedBuilding: "Of it, failed or canceled",
    business: "Business",
    project: "App",
    model: "Model",
    runKind: "Kind of run",
  },
  audit: {
    intro: "What admins did, newest first. Nothing here is ever edited or removed.",
    adminLabel: "Admin",
    businessLabel: "Business",
    anyAdmin: "All admins",
    anyBusiness: "All businesses",
    caption: "Admin actions",
    columns: ["When", "Admin", "Action", "Done to", "Detail"],
    empty: "Nothing has been recorded yet.",
    more: "Show older",
  },
  signInPage: {
    intro:
      "Schmeide is open by invitation for now. Sign in with the email address you were invited with.",
    provider: {
      google: "Continue with Google",
      microsoft: "Continue with Microsoft",
      apple: "Continue with Apple",
    },
    or: "Or sign in with your email and password",
    emailLabel: "Email",
    passwordLabel: "Password",
    action: "Sign in",
    signingIn: "Signing in…",
    help: "No password yet, or forgotten it? Ask the person who invited you for a new link.",
    notInvited: "Not invited yet? Ask for early access",
    signedOut: "You are signed out.",
    // Why a sign-in was refused. `refused` is keyed by the reason the server sends back.
    refused: {
      not_approved:
        "That email address is not on the invitation list yet. Sign in with the address you were invited with, or ask us to add this one.",
      email_not_verified:
        "That account has not confirmed its email address, so we cannot be sure it is yours. Confirm it with the provider, or sign in another way.",
    },
    providerFailed: "That sign-in did not finish. Try again, or sign in another way.",
    wrong: "That email and password do not match. Check both and try again.",
    tooMany: "Too many tries. Wait a minute, then try again.",
    failed: "Sign-in did not work this time. Try again in a moment.",
    deleted: "Your account is deleted, and you are signed out everywhere.",
  },
  signUpPage: {
    inviteOnly:
      "Schmeide is open by invitation while we work with a first group of businesses. Ask for early access, and we will email you a link to set up your account once we can take you on.",
    askForAccess: "Ask for early access",
    signIn: "Already invited? Sign in",
    planKept: "The plan you chose comes with you. It will be ready when you set up payment.",
  },
  // The first-run page (/welcome): a signed-in person with no business yet sets one up.
  firstRun: {
    intro:
      "A few details and you can start on your first app. You can change the name and country later.",
    yourNameLabel: "Your name",
    yourNameMissing: "Type your name.",
    nameLabel: "Business name",
    // Matches the name the server gives a business when none is typed (startBusiness).
    defaultName: (yourName: string) => `${yourName}’s business`,
    nameHint: "Optional. Leave it empty to use the name shown.",
    countryLabel: "Country",
    countryNone: "Choose a country",
    countryHint: "Used for tax, and for which terms apply to your business.",
    countryMissing: "Choose the country your business is in.",
    descriptionLabel: "What the business does",
    descriptionHint:
      "Optional. One line, such as “A bakery with two shops”. It gives the interview about your first app a head start.",
    save: "Set up my business",
    saving: "Setting up your business…",
  },
  setPasswordPage: {
    intro: (email: string) =>
      `Choose a password for ${email}. You will sign in with it from now on.`,
    resetIntro: (email: string) =>
      `Choose a new password for ${email}. You will be signed out everywhere else.`,
    nameLabel: "Your name",
    passwordLabel: "Password",
    passwordHint: (length: number) => `At least ${length} characters.`,
    confirmLabel: "Password again",
    mismatch: "The two passwords are not the same. Type them again.",
    action: "Save and sign in",
    saving: "Saving…",
    deadTitle: "This link no longer works",
    dead: "It was already used, it is more than 7 days old, or a newer link replaced it. Ask the person who invited you for a new one.",
    toSignIn: "Go to sign in",
    savedButSignedOut: "Your password is saved. Sign in with it to continue.",
    invitedIntro: (business: string, email: string) =>
      `You are invited to join ${business}. Choose a password for ${email}. You will sign in with it from now on.`,
    joinTitle: (business: string) => `Join ${business}`,
    joinIntro: (business: string, email: string) =>
      `${email} is invited to work on the apps of ${business}. Your own business and your password stay as they are.`,
    join: (business: string) => `Join ${business}`,
    joining: "Joining…",
    joinSignIn: (email: string) =>
      `This address already has an account. Sign in as ${email} and you come back here to join.`,
    joinSignInAction: "Sign in to join",
    joinWrongPerson: (invited: string, current: string) =>
      `This invitation is for ${invited}, but you are signed in as ${current}. Sign out, sign in as ${invited}, then open the link again.`,
  },
  businessPage: {
    readOnly:
      "You are an editor of this business. Only an owner can change its name and country, its members, and its invitations.",
    gone: "That was already changed or removed by someone else. The page shows how things are now.",
    details: {
      title: "Name and country",
      nameLabel: "Business name",
      nameMissing: "Type a name for the business.",
      countryLabel: "Country",
      countryNone: "Not chosen yet",
      save: "Save name and country",
      saving: "Saving…",
      saved: "Saved.",
    },
    members: {
      title: (count: number) => `Members (${count})`,
      roleHelp:
        "An owner can do everything. An editor can make and change apps, but cannot change the business, its members, or billing.",
      roles: { owner: "Owner", editor: "Editor" },
      you: "(you)",
      joined: (date: string) => `Joined ${date}`,
      alone: "You are the only member. Invite someone below to work on the apps with you.",
      onlyOwner:
        "You are the only owner, so you cannot leave or become an editor. Make someone else an owner first.",
      makeOwner: (name: string) => `Make ${name} an owner`,
      makeOwnerConfirm: (name: string) =>
        `An owner can do everything here, including removing you. Keep ${name} beside you as a second owner, or hand the business over and become an editor yourself.`,
      makeOwnerToo: (name: string) => `Make ${name} an owner too`,
      handOver: (name: string) => `Make ${name} the owner and me an editor`,
      changeNothing: "Change nothing",
      makeEditor: (name: string) => `Make ${name} an editor`,
      remove: (name: string) => `Remove ${name}`,
      removeConfirm: (name: string, business: string) =>
        `Remove ${name} from ${business}? They lose its apps at once. Their account, and any other business they are in, stay as they are.`,
      keep: (name: string) => `Keep ${name}`,
      leave: (business: string) => `Leave ${business}`,
      leaveConfirm: (business: string) =>
        `Leave ${business}? You lose its apps at once. If it is your only business, you get a new, empty one.`,
      stay: "Stay a member",
      working: "Working…",
    },
    invitations: {
      title: "Invitations",
      intro:
        "Schmeide does not send email yet. Type the person’s email address to get a link, then send the link to them yourself. They join as an editor.",
      emailLabel: "Email address of the person to invite",
      emailMissing: "Type their email address, for example name@example.com.",
      add: "Create an invitation link",
      adding: "Creating…",
      linkLabel: (email: string) => `Invitation link for ${email}`,
      linkHelp: (days: number) =>
        `Copy this link now and send it to them. It is shown only this once, works one time, and stops working after ${days} days. If it gets lost, make a new link in the list below.`,
      copyLink: "Copy the link",
      copied: "Copied.",
      copyFailed: "Could not copy. Select the link and copy it yourself.",
      waitingTitle: (count: number) => `Waiting (${count})`,
      none: "No invitations are waiting.",
      invited: (date: string) => `Invited ${date}`,
      expired: "Its link is too old to use. Make a new link.",
      renew: (email: string) => `Make a new link for ${email}`,
      renewHelp: "Making a new link stops the old one from working.",
      withdraw: (email: string) => `Withdraw the invitation for ${email}`,
    },
  },
  // What a member of a suspended business sees in place of its pages.
  suspended: {
    title: "This business is suspended",
    body: "Its apps keep running, but nothing in it can be opened or changed for now. Get in touch and we will help.",
    contact: "Get in touch",
  },
  accountPage: {
    profile: {
      title: "Profile",
      nameLabel: "Name",
      save: "Save name",
      saving: "Saving…",
      saved: "Saved.",
      emailLabel: "Email",
      emailNote:
        "You cannot change your email address here yet. Ask the person who invited you to change it.",
    },
    methods: {
      title: "How you sign in",
      kind: {
        password: "Password",
        google: "Google",
        microsoft: "Microsoft",
        apple: "Apple",
      },
      connectedOn: (date: string) => `Connected on ${date}`,
      notConnected: "Not connected",
      noPassword: "Not set. Ask the person who invited you for a set-password link.",
      connect: (method: string) => `Connect ${method}`,
      opening: (method: string) => `Opening ${method}…`,
      disconnect: (method: string) => `Disconnect ${method}`,
      disconnecting: "Disconnecting…",
      disconnected: (method: string) => `${method} disconnected.`,
      onlyOne: "You need at least one way to sign in, so your only one cannot be disconnected.",
      connectFailed:
        "That sign-in method was not connected. Use an account with the same email address as this one, then try again.",
    },
    devices: {
      title: "Where you are signed in",
      named: (browser: string, os: string) => `${browser} on ${os}`,
      unknown: "Unknown browser",
      thisDevice: "This device",
      lastActive: (date: string) => `Last active ${date}`,
      signOutOthers: "Sign out everywhere else",
      signingOut: "Signing out…",
      signedOutOthers: "Signed out everywhere else.",
    },
    details: {
      title: "Details",
      intro:
        "Download a copy of what Schmeide holds about you: your profile, how you sign in, where you are signed in, and your businesses and their apps.",
      download: "Download my details",
      preparing: "Preparing your download…",
      fileName: "schmeide-my-details.json",
    },
    delete: {
      title: "Delete account",
      intro:
        "This deletes your name, email address and sign-in methods straight away and signs you out everywhere. It cannot be undone. To use Schmeide again, you would need a new invitation.",
      outcome: {
        leave: (business: string) => `${business} carries on without you, with its apps.`,
        remove: (business: string) => `${business} is deleted too. It has no apps and nobody else.`,
      },
      blockedTitle: "Before you can delete your account",
      blocked: {
        deleteApps: (business: string) => `${business} still has apps. Delete them first.`,
        handOver: (business: string) =>
          `You are the only owner of ${business}, and other people work in it or are invited to it. Someone else needs to own it first, which you cannot do from here yet.`,
      },
      toApps: "Go to your apps",
      start: "Delete my account",
      confirmLabel: (email: string) => `To confirm, type ${email}`,
      confirm: "Delete my account",
      cancel: "Keep my account",
      deleting: "Deleting…",
      mismatch: "That is not the email address of this account. Type it exactly as shown.",
    },
  },
  // Not found and no access are one page, so it never tells a non-member that an app exists.
  problems: {
    title: "Page not found",
    body: "This address does not lead to anything you can open: it may be mistyped, the app may have been deleted, or it belongs to a business you are not in.",
    signedInAs: (email: string) => `You are signed in as ${email}.`,
    action: "Go to your apps",
    toMarketingSite: "Go to schmeide.com",
  },
  signedOutPage: {
    title: "You were signed out",
    body: "Your session ended while this page was open; sign in to come back to it, with anything you typed and did not send still there.",
    action: "Sign in and come back",
  },
  offline: {
    title: "You are offline",
    body: "This browser has no internet connection right now; anything you typed and did not send is kept.",
    retrying: "Schmeide tries again by itself every 10 seconds.",
  },
  maintenance: {
    title: "Schmeide is down for planned work",
    body: (when: string) => `We are making improvements. Come back after ${when}.`,
  },
  list: {
    title: "Your apps",
    newApp: "New app",
  },
  start: {
    title: "What do you need?",
    intro:
      "Say it in your own words, as you would to a person. Schmeide then asks a few questions and writes the plan down with you.",
    needPlaceholder:
      "I run a small plumbing business. I need to send invoices from my phone when a job is done, and see who has not paid yet.",
    needMissing: "Write a sentence about what you need, or choose a starting point below.",
    pointsTitle: "Or start from one of these",
    pointsHint: "Choosing one writes a first answer for you. Change it as much as you like.",
    points: [
      { name: "Invoices", need: "I need to send invoices to my clients and see who has paid." },
      {
        name: "Bookings",
        need: "I need to take bookings from my customers and see my day at a glance.",
      },
      {
        name: "Client list",
        need: "I need to keep a list of my clients with their details and notes about each one.",
      },
      {
        name: "Stock list",
        need: "I need to keep track of what I have in stock and know when to order more.",
      },
      {
        name: "Job tracker",
        need: "I need to track each job from the first call to the day it is paid.",
      },
    ],
    ways: {
      label: "Where you are starting from",
      idea: "I have an idea",
      existing: "I already have something",
    },
    builds:
      "Schmeide builds apps that open in a browser, on a phone or a computer. It does not build apps for the app stores, and the apps it builds do not connect to other tools yet.",
    askForIt: "Ask for something it does not build",
    continue: "Continue",
    continuing: "Thinking of the first question…",
    unfinishedTitle: "Continue where you left off",
  },
  today: {
    title: "What you have today",
    intro:
      "Tell us what does this job for you now. Schmeide starts your plan from it, so nothing you rely on gets lost.",
    usesLegend: "What do you use for this today?",
    usesHint: "Choose every one that applies.",
    usesMissing: "Choose at least one thing you use today.",
    uses: {
      spreadsheet: { label: "A spreadsheet", appName: "In place of my spreadsheet", note: null },
      paper: { label: "Paper", appName: "In place of paper", note: null },
      product: {
        label: "A product I pay for",
        appName: "In place of a product I pay for",
        note: "Schmeide builds your own app with the same kinds of features. It does not copy the other product’s name, logo, wording, or look.",
      },
      software: {
        label: "Software built for me",
        appName: "In place of my software",
        note: "Schmeide cannot change that software. It builds a new app that does the same job.",
      },
      website: {
        label: "A website",
        appName: "Beside my website",
        note: "Your website stays as it is. The app sits beside it at its own address.",
      },
    },
    keepLabel: "What works well and must not change?",
    keepDecide: "You decide",
    keepDecideHint: "Schmeide works out what to keep and marks it in your plan.",
    fixLabel: "What gets in your way?",
    fixMissing: "Write a sentence about what gets in your way today.",
    builtHere: "Changing an app you built here? Open it from",
    builtHereLink: "your apps",
  },
  project: {
    back: "← All projects",
    statusPrefix: "Status:",
    // Setting an app up, until its first build passes: one step at a time.
    setup: {
      label: "Setting up your app",
      steps: ["Describe", "Spec", "Build", "Live"],
      done: "(done)",
    },
    // The app's home once it has been live: the designer, and its settings.
    views: {
      label: "This app",
      designer: "Designer",
      overview: "App",
      changes: "Changes",
      settings: "Settings",
    },
    viewTitle: (view: string, name: string) => `${view} · ${name}`,
    // The designer: the app itself in a frame, with the way to change it beside it.
    designer: {
      tabsLabel: "App or changes",
      appTitle: "Your app",
      frameTitle: (name: string) => `${name}, the version being worked on`,
      widthLabel: "Width",
      width: { phone: "Phone", computer: "Computer" },
      reload: "Reload the app",
      reloadOnBuild: "Reload when a change is built",
      newVersion:
        "The version being worked on has changed. Reloading returns it to its first screen.",
      reloadNew: "Reload",
      loading: "Loading your app…",
      frameHelp:
        "If your app does not appear here, open it in its own tab with “Open the version being worked on”. Some apps cannot be shown inside another page.",
      building:
        "A change is being built. This is the version being worked on as it is now; the change appears here when the build finishes. Your customers keep seeing your live app.",
      buildingNoApp:
        "Your app is being built. It appears here when the build finishes; this page updates by itself.",
      failed:
        "The last change did not finish, so this is the version being worked on from before it. See what went wrong under “Latest change”.",
      canceled: "You canceled this build, so this is the version being worked on from before it.",
      offline:
        "Your app is offline, so there is nothing to show here. To bring it back, put a version live: this one, when it is offered below, or a change you request.",
      buildsToStaging:
        "Your change is built into the version being worked on, for you to look at first. Your customers see it once you put it live.",
      noChanges: "No changes yet. The first change you request shows here while it is built.",
    },
    appBuildingHint:
      "A change is being built. Your live app stays as it is; this page updates by itself.",
    // The two copies of an app: the version being worked on (staging), and the live app its
    // customers use (production).
    release: {
      showing:
        "This is the version being worked on. It keeps its own information, separate from your live app's: nothing entered here reaches your customers.",
      same: "Your customers see this same version.",
      ahead: (count: number) =>
        count === 1
          ? "It has 1 change your customers do not see yet."
          : `It has ${count} changes your customers do not see yet.`,
      promote: "Put this version live",
      promoteHint:
        "Your live app then runs this version. The information your customers entered is kept, and updated to fit the new version.",
      promoting: "Starting…",
      discard: "Throw these changes away",
      discardConfirm: (count: number) =>
        `Throw away ${count === 1 ? "the change" : `the ${count} changes`} your customers do not see yet? The version being worked on goes back to what your customers see, and its own information is emptied. Your live app and its information are not touched.`,
      discardYes: "Yes, throw them away",
      discardNo: "Keep them",
      discarding: "Starting…",
      noDiscardYet:
        "Your app went live before Schmeide kept track of versions, so these changes cannot be thrown away yet. Once you put this version live, later changes can be.",
      promoteRequest: "Put the version being worked on live.",
      discardRequest: "Throw away the changes your customers did not see yet.",
      askedBy: (name: string) => `Asked for by ${name}.`,
    },
    appFailedHint:
      "The last change did not finish. See what went wrong under “Latest change”, then request a change to try again.",
    canceledHint: "You canceled this build. Request a change to build again.",
    retryTitle: "Try again",
    firstBuildTitle: "First build",
    manageBusy: "You can delete the project once the build has finished.",
    // The stepper already numbers this step. A leading "1." reads as the first interview question.
    featuresTitle: "What your app should do",
    featuresIntro:
      "Write one request in each box, in your own words. Press Enter or “Add another request” for a new box.",
    featuresLabel: "Your requests",
    requestLabel: (position: number) => `Request ${position}`,
    requestPlaceholders: [
      "Keep a list of my clients with their name and email",
      "Create an invoice for a client with line items",
    ],
    addRequest: "Add another request",
    removeRequest: "Remove",
    removeRequestLabel: (position: number) => `Remove request ${position}`,
    saveFeatures: "Save",
    saving: "Saving…",
    saved: "Saved.",
    writeSpec: "Write the spec",
    startingSpec: "Starting…",
    needFeatures: "Add at least one request first.",
    discardWarning:
      "Saving new requests throws away the spec below. You will then write a new spec from the new requests.",
    cancelEdit: "Keep the current spec",
    // Why the last spec run failed, keyed by the server's reason, and what to do about it.
    specFailed: {
      claude_login:
        "The spec could not be written because this Schmeide server is not signed in to Claude. You cannot fix that from this page: whoever runs the server should run “make doctor” and follow what it says. Then press “Write the spec” again.",
      usage_limit:
        "The spec could not be written because this Schmeide server has reached its Claude usage limit for now. Your requests are fine. Wait a few hours, then press “Write the spec” again.",
      timed_out:
        "Writing the spec took too long and was stopped. Your requests are fine. Press “Write the spec” again.",
      suspended:
        "The spec could not be written because this business is suspended. You cannot fix that from this page: ask whoever runs Schmeide to restore it.",
      unknown:
        "The spec could not be written because something went wrong on the server. Press “Write the spec” again. If it fails again, you cannot fix it from this page: whoever runs the server should run “make doctor”.",
    },
    specTitle: "2. Spec",
    specWriting:
      "Writing your spec. This usually takes under a minute, and this page updates by itself.",
    specIntro: "This is what Schmeide will build. Read it through before approving it.",
    approve: "Approve and build",
    approving: "Starting the build…",
    buildsOff:
      "Building apps is not open yet. Your spec is saved, and you can approve it here once building opens.",
    changeFeatures: "Change the requests",
    builtFrom: "The spec your app started from",
    builtFromUnchanged: "No changes have been built since, so this still describes your app.",
    builtFromChanged:
      "Your app has changed since this was written. The spec is kept as it was; the changes built after it are listed here, oldest first.",
    changesSince: "Changes built since",
    showSpec: "Show the spec",
    showNeed: "Show what you first asked for",
    // The app's look (#159), shown while the design team is on.
    look: {
      title: "Look",
      current: (name: string) => `Your app has the ${name} look.`,
      why: {
        lead: (reason: string) => `Why Schmeide chose it: ${reason}`,
        fallback: () => "It is Schmeide's default look.",
        person: () => "You picked it.",
      },
      none: "Your app has no set look yet. Pick one and Schmeide restyles your app to it.",
      pickLabel: "Pick a look",
      note: "Picking another look restyles your app as a change. It goes live once the change passes, like any other.",
      use: "Use this look",
    },
    buildTitle: "3. Build",
    changeTitle: "Latest change",
    retryBuildTitle: "3. Build, another try",
    changeRequestLabel: "What you asked for:",
    siteChangeRequest: "Update the page title and icon.",
    buildStatus: {
      queued: "Waiting",
      running: "Building now",
      passed: "Finished",
      failed: "Failed",
      canceled: "Canceled",
    },
    elapsed: "Time:",
    history: {
      title: "Past builds",
      intro: "Every build before the latest one, newest first.",
      empty:
        "Only the first build so far. Each change you ask for is listed here once the next one starts.",
      firstBuild: "The first build of your app.",
      took: "Took",
      cost: "Cost",
      showLog: "Show its log",
      more: "Show older builds",
    },
    failureTitle: "What went wrong",
    summaryTitle: "What is happening",
    summaryWaiting: "An account of the build in plain words appears here as it goes.",
    summaryNone:
      "There is no account in plain words for this build. Look behind the scenes for every step.",
    behindTheScenes: "Look behind the scenes",
    logTitle: "Every step, as the builder logged it",
    logHint: "The newest step is at the bottom.",
    jumpToNewest: "Jump to the newest step",
    logEmpty: "Waiting for the first step…",
    eventKind: {
      step: "Progress",
      agent: "Builder",
      check: "Checking",
      deploy: "Publishing",
      error: "Problem",
    },
    phase: {
      step: "Getting your project ready.",
      agent: "The builder is writing your app.",
      check: "Checking that everything works.",
      deploy: "Putting your app online.",
      error:
        "The builder hit a problem and is working past it. Watch the steps below; if the build stops, it says what went wrong and how to try again.",
    },
    openStaging: "Open the version being worked on",
    openLive: "Open your live app",
    opensInNewTab: "(opens in a new tab)",
    changeTitleForm: "Request a change",
    changeIntro:
      "Describe what to add, fix, or change, in your own words. Schmeide rebuilds the app with it.",
    changeRetryIntro:
      "Describe what to fix, or just write “try again”. Schmeide builds the app again with it.",
    changeQueueIntro:
      "Describe what to add, fix, or change. A build is running now, so your change waits its turn and starts after the changes ahead of it are finished.",
    changeLabel: "The change you want",
    changePlaceholder: "Add a due date to each invoice",
    changeMissing: "Describe the change first.",
    requestChange: "Request the change",
    requesting: "Sending…",
    queueTitle: "Waiting changes",
    queueIntro:
      "These run one after another, top first, each once the build before it finishes. If a build fails or is canceled, they wait for you to build them, so you can edit or remove them first.",
    queueBuildNow: "Build the waiting changes now",
    queueStarting: "Starting…",
    queueEdit: "Edit",
    queueEditLabel: (position: number) => `Edit waiting change ${position}`,
    queueEditFieldLabel: (position: number) => `Waiting change ${position}`,
    queueSave: "Save the change",
    queueMissing: "Write the change first.",
    queueCancelEdit: "Keep it as it was",
    queueRemove: "Remove",
    queueRemoveLabel: (position: number) => `Remove waiting change ${position}`,
    queueRemoving: "Removing…",
    usageTitle: "Usage so far",
    usage: {
      inputTokens: "Tokens read",
      outputTokens: "Tokens written",
      cacheReadTokens: "Tokens reused from cache",
      cacheCreationTokens: "Tokens saved to cache",
      costUsd: "Reported cost",
    },
    time: {
      building: "Building time",
      builder: "Builder time",
      failed: (duration: string) => `${duration} of it on builds that failed or were canceled`,
      notRecorded: "Not recorded",
      partlyRecorded: "Earlier runs were not timed and are left out.",
      explained:
        "Building time runs from the start to the end of each build, checks and publishing included, and of each time you put a version live or throw changes away: the time you waited. A change waiting its turn starts counting when it starts. Builder time is how long the AI itself was working, on builds, the spec, and questions.",
    },
    site: {
      title: "Page title and icon",
      intro:
        "The name shown on the browser tab, and the small picture beside it. Saving builds them into the version being worked on, without the builder; put it live to show them to your customers.",
      titleLabel: "Page title",
      iconLabel: "Icon (a PNG or ICO file, up to 256 KB)",
      iconSet: "Your app uses your own icon. Choose a new file to replace it.",
      iconNone: "Your app uses the default icon.",
      iconTooBig: "That file is too big. Choose an icon of at most 256 KB.",
      save: "Save title and icon",
      removeIcon: "Use the default icon",
      saved: "Saved.",
    },
    manageTitle: "Manage",
    cancelBuild: "Cancel the build",
    takeOffline: "Take the app offline",
    stopping: "Stopping…",
    delete: "Delete project",
    deleteConfirm: (name: string) =>
      `Delete “${name}”? This removes your live app and the version being worked on, everything stored in both, their links, the code that was built, the spec, and the build history. This cannot be undone.`,
    deleteYes: "Delete project",
    deleteNo: "Cancel",
    deleting: "Deleting… this can take a few seconds.",
  },
  interview: {
    intro:
      "Answer a few questions and Schmeide writes down what your app needs as you go. Most answers are a choice. You can always answer in your own words, or let Schmeide decide.",
    start: "Start the questions",
    starting: "Thinking of the first question…",
    thinking: "Thinking of the next question…",
    writeMyself: "Write it myself",
    useQuestions: "Answer questions instead",
    yes: "Yes",
    no: "No",
    other: "Something else",
    otherLabel: "In your own words",
    answerLabel: "Your answer",
    continue: "Continue",
    youDecide: "You decide",
    youDecideHint: "Schmeide picks a sensible answer and marks it in your plan.",
    needAnswer: "Choose an answer, write your own, or press “You decide”.",
    unavailable:
      "The next question could not be prepared. Try again in a moment, or press “Write it myself” to type your requests.",
    retry: "Try again",
    finished: "Those are all the questions. Read your plan, then press “Check what we understood”.",
    paused:
      "There is no question waiting. Ask for the next one, or check what we understood from your plan.",
    resume: "Ask the next question",
    planTitle: (count: number) => `Your plan (${count})`,
    sections: {
      who: "Who uses it",
      does: "What it does",
      screens: "Its screens",
      keeps: "What it keeps",
      replaces: "What it replaces",
    },
    sectionStatus: { not_started: "Not started", sketched: "Sketched", ready: "Ready" },
    sectionEmpty: "Nothing here yet.",
    tagNew: "New",
    tagSchmeide: "Schmeide chose this",
    tagLater: "Later",
    added: (items: readonly string[]) => `Added to your plan: ${items.join("; ")}`,
    answersTitle: (count: number) => `Your answers (${count})`,
    answerYouDecide: "Left to Schmeide",
    needPlan:
      "Your plan needs at least one thing under “What it does”. Answer a question first, or press “Write it myself”.",
    changeNeed: "Change what you asked for",
    needLabel: "What you need",
    needEmpty: "Write a sentence about what you need.",
    restartWarning: (answers: number, items: number) =>
      `Starting over clears ${new Intl.ListFormat("en", { type: "conjunction" }).format([
        "the questions so far",
        ...(answers ? [answers === 1 ? "your 1 answer" : `your ${answers} answers`] : []),
        ...(items
          ? [items === 1 ? "the 1 item in your plan" : `the ${items} items in your plan`]
          : []),
      ])}, then asks the first question again from your new wording.`,
    restart: "Start the questions over",
    keepQuestions: "Keep these questions",
    discardWarning:
      "Answering more questions can change your plan. If it does, the spec below is thrown away and written again from the new plan.",
  },
  // Said back to the owner after the questions and before the spec, so mistakes are caught here.
  readBack: {
    open: "Check what we understood",
    title: "Here’s what we understood",
    intro:
      "Read this through. If a sentence is wrong, press “That’s not right” beside it and answer one question. Your plan and this page change to match.",
    writing: "Writing down what we understood…",
    rewriting: "Changing your plan and writing this again…",
    failed:
      "What we understood could not be written down just now. Try again, or go on to the spec: it is written from your plan as it stands.",
    retry: "Try again",
    skip: "Go on to the spec",
    businessTitle: "Your business",
    stepsTitle: "How a piece of work goes",
    notRight: "That’s not right",
    send: "Send",
    cancel: "Cancel",
    needAnswer: "Write a few words, or press “Cancel”.",
    chosenTitle: "What we decided for you",
    chosenIntro:
      "You left these to Schmeide, or nobody asked. Change any that is not how you work.",
    change: "Change this",
    changeLabel: "What it should say",
    save: "Save",
    openTitle: "Still open",
    openIntro:
      "The questions did not settle these. Answer one now, or leave it: the spec says what was assumed.",
    answer: "Answer this",
    openLabel: "How should this work?",
    openLeft: (count: number) =>
      count === 1
        ? "1 point is still open. The spec will state it as an assumption."
        : `${count} points are still open. The spec will state them as assumptions.`,
    laterTitle: "Not in the first version",
    laterIntro: "These wait for a later change, so the first version stays small.",
    confirm: "Yes, that’s right. Write the spec.",
    print: "Print it for a second opinion",
    back: "Back to the questions",
  },
  status: {
    draft: {
      label: "Describing",
      hint: "Next: describe what your app should do below, then press “Write the spec”.",
    },
    spec_generating: {
      label: "Writing the spec",
      hint: "The spec is being written. This page updates by itself.",
    },
    spec_ready: {
      label: "Spec ready to review",
      hint: "Next: read the spec below. If it is right, press “Approve and build”.",
    },
    building: {
      label: "Building",
      hint: "Your app is being built. This can take several minutes; this page updates by itself. This first version goes live as soon as it is built, since nothing is live yet. After that, each change is built for you to look at first, and goes live when you put it live.",
    },
    live: { label: "Live", hint: "Your app is live. Open it, or request a change." },
    failed: {
      label: "Build failed",
      hint: "The build did not finish. See what went wrong below, then try again.",
    },
    stopped: {
      label: "Offline",
      hint: "Your app is offline. Put a version live to bring it back.",
    },
  },
  errors: {
    serverDownTitle: "Schmeide is not answering",
    serverDown: "Schmeide is not answering right now. Wait a moment, then press “Try again”.",
    // For a developer running the site locally, where no hosted API is set.
    serverDownLocal:
      "The server is not running. In a terminal, from the schmeide.app folder, run “make serve” (or “gmake serve”), wait until it prints the App address, then press “Try again”.",
    retry: "Try again",
    signedOut: "You are signed out. Sign in again to continue.",
    notFound: "This project no longer exists. It may have been deleted.",
    forbidden: "You do not have access to this.",
    // After the server's own sentence on why: the page refetches what it shows (ErrorNote).
    refreshed:
      "The page now shows where things stand; check it, then try again if it still applies.",
    badRequest: "That was not accepted:",
    badRequestNext: "Change it, then send it again.",
    unavailable: "That is not available right now. Wait a moment, then try again.",
    suspended: "This business is suspended. Get in touch through Help.",
    other:
      "Something went wrong. Try again; if it keeps happening, the full output is in ~/.schmeide/logs.",
  },
  duration: (minutes: number, seconds: number) =>
    minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`,
  longDuration: (hours: number, minutes: number) => `${hours} h ${minutes} min`,
} as const;
