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
      pendingNoBoard: 'Today reads from this address. A board you set up later will get it too.',
      pendingWithBoard: 'Not yet on the board — it will be sent the next time this app reaches it.',
      // What the editor says after a save, one sentence per outcome. `newsurlsync.ts` picks
      // between them; the choosing is language-free and only the words are here.
      saved: {
        fetching: 'Saved. The board is fetching it now.',
        clearedDemo: 'Cleared — the board is back on demo data.',
        todayOnly: 'Saved. Today reads from this address. A board you set up later will get it too.',
        clearedTodayDemo: 'Cleared — Today is on the demo edition.',
        noClient:
          'Saved on this phone. Not connected to a board right now — it will be sent when this app reaches one.',
        boardAsleep:
          'Saved. The board is asleep, so it will get the new address the next time this app reaches it.',
        boardBusy:
          'Saved on this phone. The board didn’t take it just now — it will get the new address the next time this app reaches it.',
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
        'The desk didn’t accept that token. Changing the edition’s language needs an operator token — a producer one can read the setting but not change it.',
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
