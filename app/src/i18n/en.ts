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
      // same in every catalogue. They are the whole of the test's exemption list.
      english: 'English',
      korean: '한국어',
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
