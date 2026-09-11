// The app's own copy, in English, and the shape every other catalogue is checked against.
//
// `Strings` is `typeof en`, so English is not merely the default table — it is the type. Adding a
// row here is what makes the compiler demand it of `ko.ts`, and `index.test.ts` is what makes the
// demand mean something at runtime as well: a key present in Korean and still carrying the English
// sentence is the failure mode a type can never see.
//
// Three rules hold this file together.
//
// **Nested by screen, never by sentence.** `settings.connection.notFound` says where the string is
// read; a flat `NOT_FOUND` says nothing and collects collisions. The nesting is also what makes the
// parity test's key paths readable in a failure report.
//
// **Interpolation is a named placeholder in the string, never a concatenation at the call site.**
// `'Found your board at {host}.'` survives a language whose word order puts the host first;
// `'Found your board at ' + host` does not, and the Korean sentence for it would have to be built
// backwards out of two fragments, one of which is empty. `fill()` in `index.tsx` does the
// substitution, and the test holds both tables to the same set of placeholders — a dropped `{ssid}`
// is the one interpolation bug a reader cannot report usefully.
//
// **What is not language stays out.** Example URLs, the `Claude Post-XXXX` access-point name, the
// quotation marks a component draws around a network name: none of those are copy, all of them are
// literals at their call sites. Anything in here that reads the same in both languages is either a
// missed translation or an endonym, and the test knows the difference by an explicit list.

export const en = {
  tabs: {
    today: 'Today',
    board: 'Board',
    markets: 'Markets',
    settings: 'Settings',
  },

  // Words used on more than one screen, defined once so the two cannot drift apart. Kept small on
  // purpose: a phrase that happens to coincide today is not shared copy, it is a coincidence.
  actions: {
    setUpMyBoard: 'Set up my board',
  },

  settings: {
    title: 'Settings',
    sections: {
      board: 'Board',
      news: 'News source',
      connection: 'Connection',
      setup: 'Setup',
      language: 'App language',
      desk: 'Desk',
      notifications: 'Notifications',
    },
    board: {
      none: 'No board set up on this phone.',
      unreachable: 'Couldn’t reach the board. Tap to retry.',
      model: 'Model',
      firmware: 'Firmware',
      deviceId: 'Device ID',
      ip: 'IP',
    },
    news: {
      help: 'The address today’s edition is fetched from — by this phone on the Today tab, and by the board when it has one. Clear it and save to fall back to the built-in demo edition.',
      lastPoll: 'Last poll',
      lastSuccess: 'Last success',
      polls: 'Polls',
      saveAddress: 'Save address',
      clearAndDemo: 'Clear and use demo data',
      derived: 'Empty, so Today reads {url} — the desk address below. Enter an address here to override it.',
      pendingNoBoard: 'Today reads from this address. A board you set up later will get it too.',
      pendingWithBoard: 'Not yet on the board — it will be sent the next time this app reaches it.',
      // What the editor says after a save, one sentence per outcome. `newsurlsync.ts` picks
      // between them; the choosing is language-free and only the words are here.
      saved: {
        // The desk's line, said first: what the address itself answered. `{edition}` is the
        // company and the dateline the desk served, which is what makes the line evidence.
        deskOk: 'Saved. The desk answered — {edition}.',
        deskOkPlain: 'Saved. The desk answered, and Today reads from this address.',
        deskFailed: 'Saved, but nothing could be read from that address. {detail}',
        // The board's line, said second, and about the board alone — the save itself is reported
        // by whichever desk line above stands over it.
        fetching: 'The board took the new address and is fetching it now.',
        clearedDemo: 'Cleared — the board is back on demo data.',
        todayOnly: 'No board on this phone yet. One you set up later will get the same address.',
        clearedTodayDemo: 'Cleared — Today is on the demo edition.',
        noClient:
          'Not connected to a board right now — it will be sent when this app reaches one.',
        boardAsleep:
          'The board is asleep, so it will get the new address the next time this app reaches it.',
        boardBusy:
          'The board didn’t take it just now — it will get the new address the next time this app reaches it.',
      },
    },
    connection: {
      help: 'The app finds your board at {host}. If that doesn’t work on your network, enter its IP address or hostname here.',
      placeholder: '192.168.0.42 or {host}',
      invalidHost: 'That doesn’t look like a valid IP address or hostname.',
      saved: 'Saved.',
      useThisAddress: 'Use this address',
      findHelp: 'Rejoined your home Wi-Fi? Find the board automatically on this network.',
      found: 'Found your board at {host}.',
      notFound: 'Couldn’t find the board. Make sure it’s powered on and on this Wi-Fi.',
      findBoard: 'Find board',
    },
    setup: {
      setUpDifferent: 'Set up a different board',
      forget: 'Forget this board',
      forgetFailed:
        'Forgotten for now, but it couldn’t be removed from this phone’s storage — it may come back the next time you open the app.',
    },
    language: {
      help: 'The language this app’s own screens are written in. An edition is written in whatever language the desk files it in.',
      system: 'System',
      // Endonyms: a language picker names every language in its own language, so these two are the
      // same in every catalogue. They are the whole of the test's exemption list. The edition's
      // language selector below reads the same two, for the same reason.
      english: 'English',
      korean: '한국어',
    },
    // The desk — the only section on this screen that talks to something that is not the board.
    // Its own block so that a copy fix to the sections above cannot collide with it.
    desk: {
      help: 'The desk that writes your paper. Give it its address and an operator token of your own, and this phone can set what the newspaper is written in. The token is kept in this phone’s keychain and sent only to the desk you name here — over https for a public address, and unencrypted if you point it at an http:// desk on your own network.',
      saveAddress: 'Save desk address',
      addressSaved: 'Saved.',
      addressInvalid: 'That doesn’t look like a desk address. Enter its hostname, or a full address beginning with http:// or https://.',
      tokenPlaceholder: 'Operator token',
      saveToken: 'Save token',
      tokenSaved: 'Saved to this phone’s keychain. It is never shown again — save a new one to replace it.',
      tokenEmpty: 'Nothing to save — the token field is empty. Any token already saved is untouched.',
      tokenHeld: 'A token is saved on this phone.',
      tokenNotSaved: 'This phone’s keychain wouldn’t store the token. Unlock the phone and try again.',
      forgetToken: 'Forget token',
      editionLanguage: 'Edition language',
      editionHelp:
        'The language the newspaper itself is written in — headlines, copy, captions and the figures’ labels. The app language above changes only this app’s own screens.',
      needsSetup: 'Add the desk’s address and an operator token to change this.',
      unsupported: 'The desk is set to a language this app doesn’t offer ({lang}). Choosing one above replaces it.',
      languageSaved: 'The desk will write the next edition in this language.',
      /** How often the desk rewrites each company's paper. `settings.py`'s 1..72 hours. */
      paperRefresh: 'Paper refresh',
      paperRefreshHelp:
        'How often the desk rewrites each watched company’s paper. Every run costs the desk about half an hour of work, so twelve hours is the default and shorter is only worth it for a short watchlist.',
      paperRefreshSaved: 'The desk paces its papers at this from now on.',
      /** The desk answered, and its settings carry no cadence: an older desk. */
      paperRefreshAbsent:
        'This desk doesn’t keep papers yet. Update it and this row starts working.',
      /** A cadence in force that is not one of the chips — set by hand, or by another client. */
      paperRefreshCustom: 'Set to {hours}h, which isn’t one of the choices above.',
    },
    // Notifications. The desk sends them; this section registers the phone that receives them and
    // edits the preferences the desk reads. Its own block, below the desk's, because every
    // sentence here is about a desk that has already been given an address and a token.
    notify: {
      help: 'Your desk tells this phone about a date in the schedule before it arrives. It sends to the phones registered here and to no others, and nothing is sent until you turn this on.',
      master: 'Tell me before it happens',
      registered: 'This phone is registered with the desk.',
      saved: 'Saved to the desk.',
      needsDesk: 'Add the desk’s address and an operator token above to turn this on.',
      unsupported: 'This phone can’t be sent notifications.',
      blocked: 'This phone doesn’t allow notifications for Claude Post. Turn them on in the phone’s own settings, then come back.',
      // The same fact over a phone the desk IS holding, and a different sentence because there is
      // now something to lose by doing nothing: the desk keeps sending into a hole. Two ways out,
      // and it names both.
      blockedRegistered:
        'This phone doesn’t allow notifications for Claude Post, so the desk’s alerts are being thrown away. Turn them on in the phone’s own settings — or turn this off, to stop the desk sending them.',
      // Said when the app could not find out where it stands, which is not the same as being off.
      unreachable:
        'This phone couldn’t ask the desk whether it’s registered, so it can’t say whether alerts are being sent. Check the address and token above.',
      retry: 'Ask the desk again',
      openSettings: 'Open phone settings',
      tokenFailed: 'The phone allowed notifications, but no push token could be issued. Check the connection and try again.',
      // Both name which half failed, because the two are fixed in completely different places and
      // "notifications didn't turn on" sends somebody to the wrong one.
      deskFailed: 'The phone allowed notifications; the desk wouldn’t register it. {detail}',
      // Not the same failure: this phone is still registered and the desk is still sending what it
      // was sending before, so the switch stays on and only the change was lost.
      changeFailed: 'The desk wouldn’t take that change, and is still sending what it was. {detail}',
      forgetFailed: 'The desk wasn’t told to stop, so it may keep sending. Try again. {detail}',
      // Neither "it worked" nor "it didn't" — the honest third answer, for a write that went out
      // to a desk that then couldn't be asked what became of it.
      unsure:
        'The desk didn’t answer, so this phone can’t tell whether that took effect. Try again once the desk is reachable. {detail}',
      // Said by the Desk section above, before it cuts this phone off from the desk holding it.
      released: 'This phone was taken off the desk’s list first, so it won’t go on being sent alerts.',
      releaseUnsure:
        'This phone couldn’t be taken off the desk’s list, so that desk may keep sending to it — and once this changes, the app can’t reach that desk to stop it. Tap again to go ahead anyway. {detail}',
      // Said AT THE MOMENT the owner goes ahead, not before it. The warning above was read at some
      // earlier point, possibly about a different control and a different network; this is the
      // sentence that belongs to the act itself.
      releasedNot:
        'Went ahead without taking this phone off that desk’s list. If it was still registered, that desk may keep sending and the app can no longer reach it to stop.',
      // The five switches. `researched` is one switch over four of the book's kinds — corporate
      // actions, court dates, index changes and everything else — so it is named by where the
      // date came from rather than by what it is.
      kinds: {
        earnings: 'Earnings',
        expiry: 'Option expiries',
        dividend: 'Dividends',
        econ: 'Economic releases',
        researched: 'Dates found by research',
        // The sixth, and the only one that is not about a future date — so it takes no lead time.
        answer: 'Answers to your messages',
      },
      leadLabel: 'How far ahead',
      // A kind can be on with nothing chosen, and it is a real setting rather than a mistake — but
      // it looks exactly like a broken switch, so it says so.
      noLead: 'On, but nothing is chosen above — nothing will be sent for these.',
      leads: {
        P7D: '1 week',
        P2D: '2 days',
        P1D: '1 day',
        PT12H: '12 hours',
        PT3H: '3 hours',
        PT1H: '1 hour',
      },
      quiet: {
        label: 'Quiet hours',
        help: 'Nothing arrives between these two times. A date that falls inside them is still told about — it arrives once the window ends, marked as already past.',
        from: 'From',
        to: 'To',
        save: 'Save quiet hours',
        shape: 'Enter a 24-hour time, like 22:00.',
        same: 'Both times are the same, which could mean no quiet hours or every hour. Set them apart.',
      },
    },
  },

  onboarding: {
    // The wizard's two top-bar controls and its forward CTA. They are quoted inside body copy
    // ("tap NEXT"), which is why the sentences below carry a `{next}` / `{again}` / `{later}`
    // placeholder rather than spelling the word a second time and letting the two drift.
    nav: {
      next: 'NEXT',
      skip: 'SKIP',
      setUpLater: 'SET UP LATER',
    },
    turnOn: {
      ctaChecking: 'CHECKING…',
      ctaCheckAgain: 'CHECK AGAIN',
      lookingTitle: 'Looking for your board',
      lookingBody: 'Looking for Claude Post on its setup Wi-Fi…',
      foundTitle: 'Board found',
      foundBody: 'Connected to {ssid}. You’re ready — tap {next} to choose your home Wi-Fi.',
      /** Stands in for the access-point name when the board did not report one. */
      theDevice: 'the device',
      turnOnTitle: 'Turn on your board',
      turnOnBody:
        'Power the board with USB-C, then in your phone’s Wi-Fi settings join the network named {ap}. Come back and tap {again}.',
      skipNote:
        'No board yet? Tap {later} — the markets, your watchlist and the charts all work without one, and you can set a board up any time from Settings.',
      apHint: 'The board reaches http://192.168.4.1 over its own Wi-Fi.',
    },
    wifi: {
      caption: 'Choose the Wi-Fi the board should join.',
      networks: 'NETWORKS',
      rescan: 'Rescan networks',
      scanning: 'Scanning…',
      scanFailed: 'Couldn’t reach the board. Make sure you’re on its setup Wi-Fi.',
      tapToRetry: 'TAP TO RETRY',
      other: 'Other…',
    },
    news: {
      caption:
        'Point the board at the JSON your news publishes on this network. Skip this and the board runs on its built-in demo data — you can add the address later from Settings.',
      label: 'Snapshot URL (optional)',
      hint: 'Plain http on your own LAN is fine — the board and the machine serving this never leave it. Run `python3 tools/mock_news_server.py` on that machine to try it out.',
    },
    password: {
      title: 'Connect Wi-Fi',
      ssidLabel: 'Network name (SSID)',
      ssidPlaceholder: 'My Home Wi-Fi',
      passwordLabel: 'Password',
      passwordPlaceholder: 'password',
      openNetwork: '(open network — none needed)',
      toggleReveal: 'Toggle password visibility',
      kicker: 'Enter the password for {ssid}',
      fetchHint: 'Once connected, the board will fetch {url}.',
      noUrlHint:
        'No snapshot URL set — the board will show its built-in demo data. You can add an address later from Settings.',
      connecting: 'Connecting to {ssid}… this can take up to a minute.',
      join: 'JOIN',
      errors: {
        network: 'Lost connection to the board. Make sure you’re still on its setup Wi-Fi.',
        passTooLong: 'That password is too long (max 64 characters).',
        ssid: 'Please check the Wi-Fi name and try again.',
        newsUrl: 'The board rejected the snapshot URL. Go back and check it.',
        tooLarge: 'That was too much for the board to accept. Shorten the snapshot URL and try again.',
        provision: 'Something went wrong sending your settings. Please try again.',
        unknown: 'Something went wrong. Please try again.',
        authFailed: 'That password didn’t work. Please check it and try again.',
        joinFailed: 'The board couldn’t join that network. Please try again.',
      },
    },
    complete: {
      title: 'Setup complete',
      connectedTo: 'Your board is connected to ‘{ssid}’.',
      connected: 'Your board is connected.',
      guidance:
        'Reconnect your phone to that same Wi-Fi network, then tap Open the Board to control your board over the local network.',
      cta: 'OPEN THE BOARD',
      ctaBusy: 'OPENING…',
    },
  },

  noBoard: {
    title: 'No board yet',
    body: 'Claude Post prints one company a day on a 13.3-inch e-paper sheet. Your watchlist, charts and ticker search all work without one.',
    setAside: 'You set this aside earlier — it’s still here when you want it.',
    alreadyHaveOne: 'I already have one on this network',
    notFound: 'Couldn’t find a board on this Wi-Fi.',
  },

  // Words that appear on more than one screen and say the same thing on each. Two ways to offer
  // another go is not a redundancy: `tryAgain` sits under a message that has just explained what
  // failed, `retry` is the compact one inside a banner beside content it could not replace, and
  // English keeps them apart at three different sizes.
  common: {
    tryAgain: 'Try again',
    retry: 'Retry',
    cancel: 'Cancel',
    refresh: 'Refresh',
  },

  // The twelve short month names, in one place — three formatters read them: `lib/format.ts`,
  // `lib/market/format.ts` and `lib/edition/freshness.ts`. They are a catalogue entry rather than
  // a constant because a month is copy: Korean numbers its months rather than abbreviating their
  // names, so this is a translation and not a spelling.
  months: {
    short: [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ],
  },

  // The seven weekday names, indexed as `Date.getDay()` does — Sunday first. `months` above says
  // why a name like this is copy and not a constant, and the same holds twice over here: Korean
  // writes a weekday as a single syllable where English abbreviates a word, so a shared table
  // would have to be a lookup in whichever language it was written in.
  weekdays: {
    short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  },

  // How the app spells a quantity that is not a number — an age, an interval, a date — and the
  // vocabulary the board's own state arrives in. Read by `lib/format.ts` and
  // `lib/market/format.ts`, both of which call `strings()` inside each function rather than at
  // module scope, so a language change is seen by a formatter imported long before it.
  format: {
    // The page switcher's names for the two sheets. The board also reports its own `pageTitle`,
    // which is what is actually printed; these name the pages the way a reader holding the paper
    // would.
    pages: {
      front: 'A1 Front',
      accounts: 'A2 Accounts',
      /** A page index a later firmware grew and this build has no name for. */
      other: 'Page {n}',
    },
    // One vocabulary for "how long ago", shared by the device's `formatAge` and the market tab's
    // `relativeTime` for the same reason `months` is shared: the two keep their own tiers and
    // their own thresholds, but "12m ago" must not be spelled two ways in one app.
    ago: {
      /** The board's -1: no poll has ever succeeded, which is not "0 seconds ago". */
      never: 'never',
      now: 'now',
      seconds: '{n}s ago',
      minutes: '{n}m ago',
      hours: '{n}h ago',
      days: '{n}d ago',
    },
    interval: {
      seconds: 'every {n}s',
      minutes: 'every {n}m',
      hours: 'every {n}h',
    },
    /** `formatDateShort`, for a date inside the current year — a year on it would be noise. */
    dateShort: '{month} {day}',
    dateShortYear: '{month} {day}, {year}',
    /** `formatGeneratedAt`: the producer's own stamp, left in the producer's own timezone. */
    generatedAt: '{day} {month} {year}, {time}',
    // The chip beside the edition: one word for each `source.lastResult`. `notModified` is a 304
    // and a SUCCESS, which is why it reads as one.
    fetchLabel: {
      ok: 'synced',
      notModified: 'up to date',
      noUrl: 'demo',
      transport: 'unreachable',
      httpStatus: 'server error',
      badPayload: 'bad payload',
      unknown: 'unknown',
    },
    // The same six results as a sentence saying what to go and check.
    fetchMessage: {
      ok: 'Last poll succeeded.',
      notModified:
        'The board asked and the desk said nothing had changed. That is a successful poll.',
      noUrl: 'No news URL set — the board is showing its built-in demo edition.',
      transport: 'Couldn’t reach that address. Is the machine serving it awake and on this network?',
      httpStatus: 'The server answered, but with an error. Check the path in the address.',
      badPayload: 'The server answered with something that isn’t an edition.',
      unknown: 'The board reported a result this app doesn’t recognise.',
    },
    /** Who set the poll cadence in force. Not decoration — see `pollSourceLabel`. */
    pollSource: {
      policy: 'set by the desk',
      board: 'built into this board',
    },
    /** Which of the four layers set the sleep interval (docs/app-control.md's table). */
    sleepSource: {
      policy: 'set by the desk',
      api: 'set from this app',
      nvs: 'set during setup',
      default: 'the board’s built-in default',
    },
  },

  // How old the thing on screen is, in tiers rather than to the second (`edition/freshness.ts`).
  freshness: {
    minutes: 'Updated {n}m ago',
    hours: 'Updated {n}h ago',
    yesterday: 'Last updated yesterday',
    date: 'Last updated {day} {month}',
  },

  // Every failure this app can name, grouped by the module that names it. Each is one sentence
  // that says what the reader can do next, or says plainly that there is nothing to do.
  errors: {
    // `esp32.ts`'s `humanError` — the board, over HTTP.
    device: {
      timeout:
        'No answer — the board is probably asleep. It wakes for a few seconds at a time and runs no server in between; press a button on it, then try again.',
      networkError: 'Couldn’t reach the board. Check it’s powered on and on the same Wi-Fi.',
      pageRange: 'That page doesn’t exist. The board has two: A1, the front page, and A2, the accounts.',
      newsUrlInvalid: 'The board wouldn’t accept that address.',
      sleepSecondsInvalid:
        'The board takes an interval of 60 seconds to 24 hours, or 0 for its built-in default.',
      busy: 'The board is busy redrawing. A refresh of this panel takes twenty to thirty seconds — try again after that.',
      noFramebuffer: 'The board is answering but hasn’t finished starting up. Give it a moment.',
      screenSize: 'The page came back the wrong size — the download was cut short. Try again.',
      screenFormat: 'This board is sending a screen format this app doesn’t know. Update the app.',
      badJson: 'The board couldn’t read that request. This is a bug in the app, not something you did.',
      tooLarge: 'That was too long for the board to accept.',
      readError: 'The board lost the request halfway through. Try again.',
      ssidEmpty: 'Pick a Wi-Fi network first.',
      ssidTooLong: 'That network name is longer than the board can store.',
      passTooLong: 'That password is longer than the board can store.',
      httpError: 'The board answered with an error. Try again in a moment.',
      unknown: 'That command failed. Please try again.',
    },
    // `newsurl.ts` — the snapshot URL, refused before the board ever sees it.
    newsUrl: {
      tooLong: 'That address is too long — the board stores at most {max} characters.',
      badScheme: 'The address must start with http:// or https://.',
      noHost: 'The address is missing a host, e.g. http://mymac.local:8123/news.json.',
      invalid: 'That doesn’t look like a valid address.',
    },
    // `edition/client.ts` — the edition the phone fetches for itself.
    edition: {
      noUrl: 'No edition URL yet. Add one in Settings.',
      transport: 'Couldn’t reach the edition server. Check the connection, then pull to refresh.',
      http: 'The edition server answered with an error.',
      httpStatus: 'The edition server answered {status}.',
      tooLarge: 'The edition is too large to read here.',
      badJson:
        'The edition didn’t parse. The desk may be mid-publish; pull to refresh in a minute.',
      unknown: 'Something went wrong reading the edition.',
    },
    // `desk.ts` — the desk's control plane, the one place the app sends a credential. `refused`
    // quotes the desk's own `detail`, which is the only thing that says what was wrong with a
    // setting it would not take.
    desk: {
      unauthorized:
        'The desk didn’t accept that token. Changing anything the desk holds — the edition’s language, the positions — needs an operator token; a producer one can read but not write.',
      transport: 'Couldn’t reach the desk. Check the address and your connection.',
      http: 'The desk answered with an error.',
      httpStatus: 'The desk answered {status}.',
      refused: 'The desk wouldn’t take that: {detail}',
      badJson: 'That address answered, but not like a desk. Check it and try again.',
      unknown: 'Something went wrong talking to the desk.',
    },
    // `market/types.ts` — Yahoo Finance. `crumb` is deliberately gentle: from EU IPs the cookie
    // bootstrap failing is a normal outcome and most of the tab keeps working.
    market: {
      transport: 'Couldn’t reach Yahoo Finance. Check your connection.',
      http: 'Yahoo Finance answered with an error. Try again in a moment.',
      rateLimited: 'Yahoo is rate-limiting requests. Try again in a minute.',
      crumb: 'Yahoo is limiting detailed data right now. Prices and news still work.',
      parse: 'Yahoo answered with something this app doesn’t understand.',
      notFound: 'No data for that symbol.',
      unknown: 'Something went wrong talking to Yahoo Finance.',
    },
  },

  board: {
    connecting: 'Connecting…',
    loading: 'Loading…',
    /** The two failures the tab writes itself, when the error is not an `Esp32Error`. */
    unreachable: 'Couldn’t reach the board.',
    commandFailed: 'That command failed. Please try again.',
    chips: {
      demo: 'demo edition',
      stale: 'stale',
      sleeps: 'sleeps',
    },
    hero: {
      none: 'No edition yet',
      noneBody:
        'The board has not parsed an edition since it started. Everything below describes the board, not a page.',
    },
    sections: {
      headlines: 'Headlines',
      panel: 'On the panel',
      source: 'Source',
      power: 'Power',
    },
    // What ARRIVED, after parsing — the difference between a thin day and a dropped field.
    counts: {
      stories: '{n} stories',
      figures: '{n} figures',
      briefs: '{n} briefs',
      peers: '{n} peers',
      tables: '{n} tables',
      charts: '{n} charts',
      photos: '{n} photos',
    },
    panel: {
      switching: 'Switching… a page change is a full refresh, which takes twenty to thirty seconds.',
      showing: 'Showing “{page}”. A refresh of this panel last took {ms}.',
      seeOnGlass: 'See the page on the glass',
    },
    source: {
      url: 'URL',
      notSet: 'not set (demo)',
      lastPoll: 'Last poll',
      lastSuccess: 'Last success',
      polls: 'Polls',
      note: 'The address itself is changed from the Settings tab.',
    },
    power: {
      deepSleep: 'Deep sleep',
      on: 'on',
      off: 'off',
      wakes: 'Wakes',
      sinceUnplug: 'Since last unplug',
      wakeCounts: '{wakes} wakes, {quiet} of them quiet',
      notSleptYet: 'has not slept yet',
      awakeEach: 'Awake each time',
      battery: 'Battery',
      notFitted: 'not fitted',
      estimate:
        'About {mah} mAh a day — awake time only. It does not include the 2.3 mAh a refresh costs, or the standing sleep current, because nobody has measured that on this board yet. Expect the real figure to be higher.',
      noEstimate:
        'No estimate yet: the board has to sleep at least once before there is anything to average. Read these after a day on a wall, not after a minute.',
    },
    sleep: {
      title: 'How often it wakes',
      // The intervals offered, in the order the chips sit in. Points inside the board's
      // [60, 86400] range rather than a limit on it; the last is its 0, "use the built-in value".
      presets: ['5m', '15m', '30m', '1h', '6h', 'Default'],
      deskDriving:
        'The desk is setting the cadence at the moment, so your value is stored and waiting rather than in force.',
      fallback:
        'This is the fallback the board uses when its desk says nothing about cadence. Below fifteen minutes the cell drains noticeably faster; “Default” hands it back to the firmware.',
      sleepOff:
        'Deep sleep is off on this board — on USB with a console attached it never sleeps at all, so this setting is stored for the day it runs on a cell.',
    },
    actions: {
      pollNow: 'Poll now',
      selfTest: 'Self-test',
      note: 'Polling only redraws the panel if the edition changed. The self-test sweeps the panel for about a minute and a half, and the board answers nothing else while it does.',
    },
  },

  preview: {
    title: 'On the glass',
    /** What a screen reader says for the sheet itself. */
    sheet: 'The page currently printed on the board',
    /** The one failure this screen names itself, when the throw was not an `Esp32Error`. */
    readFailed: 'Couldn’t read the page off the board.',
    note: 'This is the framebuffer itself, in the measured inks. A frame caught mid-render can show part of one edition and part of the next — that is the download, not the panel. Fetch it again.',
    staleNote: 'The sheet above is the last one that came back, not a fresh read.',
    fetchAgain: 'Fetch it again',
    reading: 'Reading 960,000 bytes off the board, then drawing them.',
    nothingYet: 'Nothing fetched yet.',
    awakeWindow:
      'A board on a battery only answers while it is awake. Press a button on it — that holds it awake for a couple of minutes, and every request restarts the clock.',
  },

  markets: {
    title: 'Markets',
    /** The `+` in the header, which has no visible label of its own. */
    addTicker: 'Add ticker',
    remove: 'Remove',
    removeSymbol: 'Remove {symbol}',
    emptyTitle: 'Track your first ticker',
    emptyBody: 'Search any symbol and it’ll show up here with a live price and chart.',
    addATicker: 'Add a ticker',
  },

  addTicker: {
    /** `SearchField`'s own default, for a field whose caller names nothing more specific. */
    searchPlaceholder: 'Search',
    clearSearch: 'Clear search',
    placeholder: 'Symbol or company',
    idle: 'Search Yahoo Finance for any listed symbol.',
    noMatches: 'No matches.',
    addToWatchlist: 'Add {symbol} to watchlist',
    removeFromWatchlist: 'Remove {symbol} from watchlist',
  },

  marketDetail: {
    tabs: {
      info: 'Info',
      news: 'News',
      calendar: 'Calendar',
      options: 'Options',
    },
    /** The delta line's suffix on the 1D chart — the other timeframes name themselves. */
    todaySuffix: 'Today',
    noChartData: 'No chart data',
    info: {
      unavailable: 'Detailed stats unavailable',
      stats: 'Stats',
      about: 'About',
      open: 'Open',
      high: 'High',
      low: 'Low',
      volume: 'Volume',
      avgVolume: 'Avg vol',
      divYield: 'Div yield',
      wk52High: '52wk high',
      wk52Low: '52wk low',
      marketCap: 'Mkt cap',
      pe: 'P/E',
      eps: 'EPS',
      beta: 'Beta',
      employees: '{n} employees',
      readMore: 'Read more',
      showLess: 'Show less',
    },
    news: {
      unavailable: 'News unavailable',
      empty: 'No recent headlines for {symbol}.',
    },
    calendar: {
      unavailable: 'Calendar unavailable',
      /**
       * The label over this symbol's slice of the desk's event book, which sits ABOVE Yahoo's
       * dates. It names what makes the two different: Yahoo lists what is scheduled for the
       * company, the desk lists what the agent researched and reasoned about against what this
       * owner actually holds.
       */
      deskEvents: 'Against your positions',
      upcoming: 'Upcoming',
      empty: 'No scheduled events.',
      pastEarnings: 'Past earnings',
      earnings: 'Earnings',
      estimatedDate: 'Estimated date',
      exDividend: 'Ex-dividend date',
      dividendPayable: 'Dividend payable',
      /** A beat or a miss, in one tabular line. */
      epsActualVsEstimate: 'EPS {actual} vs {estimate} est',
    },
    options: {
      unavailable: 'Options unavailable',
      switchError: 'Couldn’t load that expiry — still showing {date}. {reason}',
      calls: 'Calls',
      puts: 'Puts',
      emptyCalls: 'No calls for this expiry.',
      emptyPuts: 'No puts for this expiry.',
      showAll: 'Show all strikes',
      showFewer: 'Show fewer',
      putCallRatio: 'Put/Call ratio (OI)',
      maxPain: 'Max pain',
      impliedVolatility: 'Implied volatility',
      /** Both sides on one line, in the analysis card. */
      ivBothSides: 'calls {calls} · puts {puts}',
      // The chain's four column captions. They sit in a narrow tabular row with `numberOfLines`
      // of 1, so a long spelling ellipsizes rather than wrapping.
      strike: 'Strike',
      bidAsk: 'Bid / Ask',
      volOi: 'Vol · OI',
      iv: 'IV',
    },
  },

  // The Today tab: the edition as the phone reads it. The COPY on this screen arrives in the
  // payload and is drawn in whatever language the desk filed it in — what is here is only the
  // furniture the app puts around it, which follows the phone's language like every other screen.
  today: {
    notInEdition: 'This item isn’t in today’s edition.',
    more: 'More from this edition',
    demoChip: 'Demo edition',
    // Under the chip, because the chip alone names the state without saying why the phone is
    // in it — and the date on a bundled edition is months old, which reads as a stuck app.
    demoNote: 'No edition address yet. Add one — or a desk address — in Settings to read today’s paper.',
    /** The filter row, in `lib/edition/tiles.ts`'s canonical order. */
    chips: {
      all: 'All',
      stories: 'Stories',
      numbers: 'Numbers',
      accounts: 'Accounts',
      photos: 'Photos',
    },
    // A module's own heading. Four of them are the app's words for a kind of tile; the other three
    // are the fallback for a producer that filed the module with no title of its own.
    heads: {
      range: 'Range',
      briefs: 'Briefs',
      peers: 'Peers',
      tape: 'The tape',
      figures: 'Figures',
      chart: 'Chart',
      statement: 'Statement',
    },
    /** The tile's four day figures, and the detail page's six. */
    range: {
      weeks52: '52 weeks',
      open: 'Open',
      prevClose: 'Prev close',
      high: 'High',
      low: 'Low',
      previousClose: 'Previous close',
      dayHigh: 'Day high',
      dayLow: 'Day low',
      wk52High: '52-week high',
      wk52Low: '52-week low',
    },
    /** What a tile shows instead of the rows it had no room for. */
    andMore: '+{n} more',
    // What a screen reader says for a tile. It names the CONTENT, not the shape — the reader is
    // choosing between tiles, and the kind alone does not tell two of them apart.
    a11y: {
      photograph: 'Photograph',
      photographCaption: 'Photograph. {caption}',
      range: 'Range for {symbol}',
      chart: 'Chart, {label}, {span}',
      figures: '{group}, {n} figures',
      briefs: '{n} briefs',
      peers: '{n} peers',
    },
  },

  // What the owner holds, named the way an option chain names it. The desk derives the STRATEGY
  // (`positions.py`'s `derive_strategy`) and this catalogue supplies the WORDS. There is no entry
  // for a shape the desk cannot name: `custom` renders as its legs rather than taking a name
  // nobody derived, because a mislabelled spread is worse than an unlabelled one.
  positions: {
    right: {
      call: 'Call',
      put: 'Put',
    },
    side: {
      long: 'Long',
      short: 'Short',
    },
    // One template per shape, and word order is the whole reason they are templates: Korean puts
    // the side, and the word "expiry" itself, where English cannot.
    strategy: {
      /** A lone leg. Long is unmarked — a bought option is what an option chain assumes. */
      single: '{expiry} {strike} {right}',
      singleShort: 'Short {expiry} {strike} {right}',
      /** The one name the desk cannot derive: it needs the shares sitting in another position. */
      covered: 'Covered Call {strike}',
      vertical: '{right} Vertical {low}/{high}',
      calendar: '{right} Calendar {strike}',
      straddle: '{side} {strike} Straddle',
      strangle: '{side} {low}/{high} Strangle',
      /** One leg inside the list a shape with no name falls back to. */
      leg: '{side} {strike} {right}',
      // A stock holding, and the one-share form of each. English needs the singular and Korean
      // does not — `positionSheet.contract` / `contracts` is the same pair for the same reason —
      // so the split is carried here rather than built out of fragments at the call site, and the
      // Korean value under both keys is the one string it has. `{n}` stays in the singular
      // deliberately: it is grouped by `formatCount`, and the parity test holds both catalogues to
      // the same placeholders.
      stockOne: '{n} share',
      stock: '{n} shares',
      stockShortOne: '{n} share short',
      stockShort: '{n} shares short',
    },
  },

  // The sheet that opens on a search result, where somebody says what they hold. `positions` above
  // is the vocabulary — a call is a call on every screen — and this is the sheet's own copy: the
  // chips, the four fields a leg has, and the sentence that says the position back before it is
  // saved. Nothing here names a strategy; that is `positions.strategy`'s job and the desk's.
  positionSheet: {
    open: 'Add a position in {symbol}',
    title: 'What do you hold?',
    /** Toss's *Predictable Hint*: say what the next step is before it arrives. */
    help: 'Pick the shape first and the fields follow.',
    shape: {
      stock: 'Stock',
      longCall: 'Long call',
      longPut: 'Long put',
      shortCall: 'Short call',
      shortPut: 'Short put',
      spread: 'Spread',
    },
    /** The heading over one leg form, when a shape opens more than one. */
    leg: 'Leg {n}',
    fields: {
      quantity: 'Shares',
      expiry: 'Expiry',
      strike: 'Strike',
      contracts: 'Contracts',
      price: 'Average price',
    },
    hints: {
      sharePrice: 'What you paid per share.',
      legPrice: 'What you paid per contract.',
    },
    /** The size on the confirmation line. Korean has one form; English has two. */
    contract: '{n} contract',
    contracts: '{n} contracts',
    confirmTitle: 'Here’s what I’ll record.',
    confirmHelp: 'Read the strike and the expiry once more — this is the step that catches a typo.',
    continue: 'Continue',
    edit: 'Edit',
    save: 'Save',
    needsDesk: 'Add your desk address and an operator token in Settings first.',
    // Every one of these is checked before anything is sent. The desk checks them again and its
    // answer wins; these exist so the ordinary mistake is caught under the field that caused it
    // rather than after a round trip, as a JSON path.
    errors: {
      symbol: 'A ticker is upper-case letters, digits, “.” and “-”.',
      required: 'Fill this in.',
      notAmount: 'An amount, like 420 or 420.50.',
      precision: 'Two decimal places at most.',
      notCount: 'A whole number.',
      strikeRange: 'A strike is more than zero.',
      tooLarge: 'That is larger than the desk will take.',
      quantityZero: 'Zero is the absence of a position, not a small one.',
      quantityRange: 'At most {max} shares.',
      contractsRange: 'Between 1 and {max} contracts.',
      dateShape: 'A date, as 2026-11-21.',
      dateReal: 'That day doesn’t exist.',
      expiryFar: 'An expiry can be at most {years} years out.',
    },
  },

  // The event book, on the phone. `positions` above is the vocabulary for what the owner holds;
  // this is the copy for what is about to happen to it. Everything the agent wrote — the title,
  // the reason, the shortfall sentence — arrives already in the edition's language and is drawn
  // as it came; nothing here translates it. What is here is the FURNITURE: the day headings, the
  // three precisions the left rail can carry, the three directions the right rail can carry, and
  // the sentences for having nothing to show.
  schedule: {
    title: 'Schedule',
    // Near days are named and dated; a far one is only dated. Both templates carry the whole
    // sentence rather than a shared separator, because "Today ·" is word order and the separator
    // is the only part of it that happens to be the same today.
    day: {
      today: 'Today · {date}',
      tomorrow: 'Tomorrow · {date}',
      dated: '{month} {day} ({weekday})',
    },
    // The left rail, at the precision the event actually has — never invented. An exact time is a
    // clock and needs no words; the other two are the only answers a company gives when it says
    // *when*, and "all day" is the honest reading of a date with no time on it at all.
    when: {
      bmo: 'Before open',
      amc: 'After close',
      allDay: 'All day',
    },
    // The right rail: what this date means to THIS owner, not what a calendar site ranks it. The
    // mark travels inside the string so a language that puts it after the word can.
    direction: {
      for: '↑ Helps',
      against: '↓ Hurts',
      both: 'Both ways',
    },
    /**
     * Days to expiry, beside the name of an option position — the number that decides whether an
     * event reaches it at all. A stock has no expiry and takes none of this; an expired leg takes
     * none either, because there is nothing left to count down to.
     */
    countdown: 'Exp D-{n}',
    /**
     * The collapsed row names one position; this says how many more the event reaches.
     *
     * The partitive is not a flourish: `{n}` is `affects.length - 1`, so an event that reaches
     * exactly two positions renders this with a 1 in it, and "+1 more positions" is the reading
     * this phrasing exists to avoid. Korean needs none of that — `포지션 {n}개 더` counts either
     * way — which is why the two sentences are shaped differently for once.
     */
    alsoAffects: '+{n} more of your positions',
    // The block at the top of Markets: the next few dates, and the way through to the whole book.
    // It appears only when there IS a book, so none of these is ever an empty state.
    upcoming: {
      title: 'Coming up',
      /** `{n}` is the WHOLE book and not the three shown — the count is the reason to tap. */
      seeAll: 'See all {n}',
    },
    /** Fewer than the target cleared the floor. The desk's own sentence goes under this. */
    shortfallLabel: 'Why there aren’t more',
    // Three empties, and they are three different facts. Only the first asks for anything: the
    // other two are the desk saying so, and a sentence that sent somebody to check their settings
    // over either would be sending them after a fault that is not there.
    empty: {
      needsDesk: 'The schedule comes from your desk. Add its address and an operator token in Settings.',
      noBook: 'Your desk hasn’t filed a schedule yet. One is researched in the morning and again after the US close.',
      nothingUpcoming: 'Everything in the schedule has already happened. The next one is filed in the morning.',
    },
    a11y: {
      expand: 'Show the whole reason',
      collapse: 'Hide the whole reason',
      openSource: 'Open {host}',
      /**
       * The badge on a researched date whose host could not be read — a malformed source, or one
       * carrying credentials, where `sourceBadge` refuses to name an authority it cannot vouch
       * for. The mark is drawn but is not a link, so this labels a fact rather than an action.
       *
       * Named by WHERE THE DATE CAME FROM, in the vocabulary `settings.notify.kinds.researched`
       * already settled for exactly this concept — singular here because it labels one row's
       * badge rather than a switch over a whole kind. §8's promise is that a reader can always
       * tell a researched date from a computed one; without this, a VoiceOver user got silence,
       * which is indistinguishable from the computed date that carries no badge at all.
       */
      researched: 'Date found by research',
      openSchedule: 'Open the full schedule',
    },
  },
  ask: {
    title: 'Ask the desk',
    /** The Today header's button. One word, because it sits beside a masthead. */
    open: 'Ask',
    placeholder: 'Ask about today’s paper — or say what you want changed.',
    send: 'Send',
    newThread: 'New question',
    /** The screen with nothing on it yet. It says what the two kinds of message do. */
    empty:
      'Ask a question about today’s paper and the desk answers it. Ask for a change — “lead with the lawsuit”, “add what the CFO said” — and it rewrites the paper.',
    needsDesk:
      'Asking the desk needs its address and an operator token. Add them in Settings, then come back.',
    /** The composer refuses at the desk's own limit rather than posting something it will refuse. */
    tooLong: 'That’s longer than the desk takes — {max} characters at most.',
    // While it is out. Three sentences and not one spinner, because the three are minutes apart
    // and "still working" with no idea which stage is the state that feels broken.
    status: {
      sending: 'Sending…',
      pending: 'Waiting for the desk to pick this up…',
      claimed: 'The desk is working on it…',
      expired: 'Nobody picked this up, so it expired.',
      cancelled: 'This was cancelled.',
    },
    /** The chip on a turn that rewrote the paper. */
    changed: 'The paper changed',
    /** A revision the desk wrote and did not publish, and the phone could not publish either. */
    staged: 'The new paper is written but hasn’t gone out yet.',
    publish: 'Publish it',
    publishFailed: 'The desk wouldn’t publish it. {detail}',
    sendFailed: 'That didn’t reach the desk. {detail}',
    retry: 'Send again',
    forgotten: 'The desk has no record of this message, so there’s no answer to fetch.',
    failed: 'The desk couldn’t answer this. {detail}',
    /** `done` with no notes: the command finished and the worker wrote nothing. */
    noAnswer: 'The desk finished with this but wrote no answer.',
    a11y: {
      openAsk: 'Ask the desk about this edition',
    },
  },
  // The papers: one current newspaper per company on the desk's watchlist. Today pages through
  // them, the Board tab puts one on the glass, and Settings paces how often the desk rewrites one.
  papers: {
    /** The page header, above the masthead: which company this page is. */
    page: {
      /** Beside the symbol on the page that is currently on the board. */
      onBoard: 'On the board',
      /** The desk thinks this one is due a rewrite. Its own judgement, not the phone's. */
      stale: 'Due a refresh',
      /** The age line when the desk gave no `created_at` at all. */
      noAge: 'Written at an unknown time',
    },
    /** A watchlist symbol the desk has not written a paper for yet. */
    placeholder: {
      title: 'No paper for {symbol} yet',
      body: 'It’s on the watchlist, so the desk writes one on its next quiet pass. This page fills in when it does.',
    },
    /** A page whose payload would not load, with nothing cached behind it. */
    pageFailed: 'This paper wouldn’t load. {detail}',
    /** The Board tab's section. */
    board: {
      title: 'Paper on the board',
      help: 'The desk keeps a current paper for every company you watch. Tap one to print it — tomorrow’s own pick replaces it.',
      /** A row for a symbol with no paper. The row is drawn and is not tappable. */
      noPaper: 'Not written yet',
      /** The confirmation, because this spends twenty-five seconds of the panel. */
      confirmTitle: 'Print {symbol}?',
      confirmBody: 'The board redraws the whole sheet, which takes about half a minute. Tomorrow’s pick replaces it in the normal way.',
      confirm: 'Put it on the board',
      cancel: 'Cancel',
      /** After a successful publish. */
      published: '{symbol} is on the board. The panel takes about half a minute to redraw.',
      /** The desk no longer has a paper for this symbol — it was pruned since the list arrived. */
      gone: 'The desk has no paper for {symbol} any more.',
      failed: 'That didn’t go on the board. {detail}',
      a11y: {
        row: '{name}, paper written {age}',
        onBoard: '{name}, on the board now',
      },
    },
  },
}

/**
 * The shape of a catalogue. English is the type: every other language is checked against it by the
 * compiler, and against its *values* by `index.test.ts`.
 *
 * Deliberately no `as const` on the object above. It would pin every leaf to its own literal type,
 * and `ko.ts` would then have to repeat the English sentence to satisfy it — the exact opposite of
 * what this type is for.
 */
export type Strings = typeof en
