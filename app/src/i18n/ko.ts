// The app's own copy, in Korean. Typed as `Strings`, so the compiler refuses a missing key and
// `index.test.ts` refuses a key that is present and still English.
//
// Register: 존댓말 throughout, and UI-short — a Korean button label is two or three syllables, not a
// transliterated English sentence. The vocabulary is fixed so the same object is not called three
// things across five screens: board → 보드, desk → 데스크, edition → 에디션, front page → 1면. The
// masthead and the product name stay Latin ("Claude Post"): a nameplate is the paper's brand, not
// copy, which is the same rule the board's own masthead follows.
//
// What is NOT translated, and why each one: "Wi-Fi", "SSID", "IP", "JSON" and "USB-C" are what a
// Korean phone's own settings call them, so translating them would make the instruction harder to
// follow, not easier; they appear inside sentences that do differ, so the parity test still sees a
// translation. Only the two language endonyms below are identical strings, and the test names them.
//
// The placeholders travel, they do not stay put: `{host}` leads its sentence in English and takes
// a 에서/에 particle mid-sentence here. That is the whole reason the catalogue interpolates by name
// instead of concatenating at the call site. Every `{next}`, `{again}` and `{later}` is filled with
// a word ending in a consonant (다음, 다시 확인, 나중에 설정), so the 을 that follows each is correct
// for all three — check that again if any of those labels is ever reworded.

import { type Strings } from './en'

export const ko: Strings = {
  tabs: {
    today: '오늘',
    board: '보드',
    markets: '시세',
    settings: '설정',
  },

  actions: {
    setUpMyBoard: '보드 설정하기',
  },

  settings: {
    title: '설정',
    sections: {
      board: '보드',
      news: '에디션 소스',
      connection: '연결',
      setup: '초기 설정',
      language: '앱 언어',
      desk: '데스크',
    },
    board: {
      none: '이 휴대폰에 설정된 보드가 없습니다.',
      unreachable: '보드에 연결하지 못했습니다. 다시 시도하려면 누르세요.',
      model: '모델',
      firmware: '펌웨어',
      deviceId: '기기 ID',
      ip: 'IP 주소',
    },
    news: {
      help: '오늘 에디션을 가져올 주소입니다. 오늘 탭의 이 휴대폰이 사용하고, 보드가 있다면 보드도 같은 주소를 사용합니다. 비우고 저장하면 기본 데모 에디션으로 돌아갑니다.',
      lastPoll: '마지막 확인',
      lastSuccess: '마지막 성공',
      polls: '확인 주기',
      saveAddress: '주소 저장',
      clearAndDemo: '비우고 데모 데이터 사용',
      pendingNoBoard: '오늘 탭이 이 주소를 읽습니다. 나중에 설정하는 보드에도 전달됩니다.',
      pendingWithBoard: '아직 보드에 전달되지 않았습니다. 다음에 보드와 연결될 때 전송됩니다.',
      saved: {
        fetching: '저장했습니다. 보드가 지금 주소를 읽고 있습니다.',
        clearedDemo: '비웠습니다. 보드는 다시 데모 데이터를 사용합니다.',
        todayOnly: '저장했습니다. 오늘 탭이 이 주소를 읽습니다. 나중에 설정하는 보드에도 전달됩니다.',
        clearedTodayDemo: '비웠습니다. 오늘 탭은 데모 에디션을 표시합니다.',
        noClient:
          '이 휴대폰에 저장했습니다. 지금은 보드와 연결되어 있지 않아, 앱이 보드에 닿는 대로 전송됩니다.',
        boardAsleep:
          '저장했습니다. 보드가 절전 중이라, 앱이 다음에 보드에 닿을 때 새 주소를 받습니다.',
        boardBusy:
          '이 휴대폰에 저장했습니다. 보드가 지금은 받지 않았고, 앱이 다음에 보드에 닿을 때 새 주소를 받습니다.',
      },
    },
    connection: {
      help: '앱은 {host} 주소에서 보드를 찾습니다. 사용 중인 네트워크에서 찾지 못하면 보드의 IP 주소나 호스트 이름을 입력하세요.',
      placeholder: '192.168.0.42 또는 {host}',
      invalidHost: '올바른 IP 주소나 호스트 이름이 아닙니다.',
      saved: '저장했습니다.',
      useThisAddress: '이 주소 사용',
      findHelp: '집 Wi-Fi에 다시 연결하셨나요? 이 네트워크에서 보드를 자동으로 찾습니다.',
      found: '{host} 주소에서 보드를 찾았습니다.',
      notFound: '보드를 찾지 못했습니다. 전원이 켜져 있고 이 Wi-Fi에 연결되어 있는지 확인하세요.',
      findBoard: '보드 찾기',
    },
    setup: {
      setUpDifferent: '다른 보드 설정하기',
      forget: '이 보드 지우기',
      forgetFailed:
        '지금은 지웠지만 이 휴대폰의 저장소에서는 삭제하지 못했습니다. 앱을 다시 열면 보드가 되살아날 수 있습니다.',
    },
    language: {
      help: '이 앱의 화면에 사용할 언어입니다. 에디션 자체는 데스크가 작성한 언어로 표시됩니다.',
      system: '시스템',
      english: 'English',
      korean: '한국어',
    },
    desk: {
      help: '신문을 만드는 데스크입니다. 데스크 주소와 본인의 operator 토큰을 입력하면, 이 휴대폰에서 신문을 어떤 언어로 쓸지 정할 수 있습니다. 토큰은 이 휴대폰의 키체인에 보관되며 여기에 입력한 데스크에만 전송됩니다. 공개 주소는 https로 연결하지만, 집 네트워크의 http:// 데스크를 지정하면 암호화 없이 전송됩니다.',
      saveAddress: '데스크 주소 저장',
      addressSaved: '저장했습니다.',
      addressInvalid: '데스크 주소 형식이 아닙니다. 호스트 이름을 입력하거나, http:// 또는 https:// 로 시작하는 전체 주소를 입력하세요.',
      tokenPlaceholder: 'operator 토큰',
      saveToken: '토큰 저장',
      tokenSaved: '이 휴대폰의 키체인에 저장했습니다. 다시 표시되지 않으며, 바꾸려면 새 토큰을 저장하세요.',
      tokenEmpty: '저장할 내용이 없습니다. 토큰 입력란이 비어 있으며, 이미 저장된 토큰은 그대로 유지됩니다.',
      tokenHeld: '이 휴대폰에 토큰이 저장되어 있습니다.',
      tokenNotSaved: '이 휴대폰의 키체인이 토큰을 저장하지 못했습니다. 잠금을 해제한 뒤 다시 시도하세요.',
      forgetToken: '토큰 지우기',
      editionLanguage: '에디션 언어',
      editionHelp:
        '신문 자체를 쓰는 언어입니다. 헤드라인, 본문, 사진 설명, 도표의 항목 이름이 모두 이 언어로 작성됩니다. 위의 앱 언어는 이 앱 화면에만 적용됩니다.',
      needsSetup: '이 설정을 바꾸려면 데스크 주소와 operator 토큰을 입력하세요.',
      unsupported: '데스크가 이 앱에서 제공하지 않는 언어({lang})로 설정되어 있습니다. 위에서 하나를 고르면 그 언어로 바뀝니다.',
      languageSaved: '데스크가 다음 에디션부터 이 언어로 작성합니다.',
    },
  },

  onboarding: {
    nav: {
      next: '다음',
      skip: '건너뛰기',
      setUpLater: '나중에 설정',
    },
    turnOn: {
      ctaChecking: '확인 중…',
      ctaCheckAgain: '다시 확인',
      lookingTitle: '보드를 찾는 중',
      lookingBody: '설정용 Wi-Fi에서 Claude Post를 찾고 있습니다…',
      foundTitle: '보드를 찾았습니다',
      foundBody: '{ssid}에 연결되었습니다. 이제 {next}을 눌러 집 Wi-Fi를 선택하세요.',
      theDevice: '기기',
      turnOnTitle: '보드를 켜세요',
      turnOnBody:
        'USB-C로 보드에 전원을 연결한 뒤, 휴대폰의 Wi-Fi 설정에서 {ap} 네트워크에 접속하세요. 다시 돌아와 {again}을 누르세요.',
      skipNote:
        '아직 보드가 없으신가요? {later}을 누르세요. 보드가 없어도 시세, 관심종목, 차트는 그대로 쓸 수 있고, 보드는 언제든 설정에서 추가할 수 있습니다.',
      apHint: '보드는 자체 Wi-Fi에서 http://192.168.4.1 주소로 연결됩니다.',
    },
    wifi: {
      caption: '보드가 접속할 Wi-Fi를 선택하세요.',
      networks: '네트워크',
      rescan: '네트워크 다시 검색',
      scanning: '검색 중…',
      scanFailed: '보드에 연결하지 못했습니다. 보드의 설정용 Wi-Fi에 접속했는지 확인하세요.',
      tapToRetry: '다시 시도',
      other: '직접 입력…',
    },
    news: {
      caption:
        '이 네트워크에서 발행되는 뉴스 JSON 주소를 보드에 지정하세요. 건너뛰면 보드는 기본 데모 데이터로 동작하며, 주소는 나중에 설정에서 추가할 수 있습니다.',
      label: '스냅숏 주소 (선택)',
      hint: '집 안 네트워크에서는 http 주소를 그대로 써도 됩니다. 보드도, 주소를 제공하는 컴퓨터도 네트워크 밖으로 나가지 않습니다. 그 컴퓨터에서 `python3 tools/mock_news_server.py`를 실행해 시험해 보세요.',
    },
    password: {
      title: 'Wi-Fi 연결',
      ssidLabel: '네트워크 이름 (SSID)',
      ssidPlaceholder: '우리집 Wi-Fi',
      passwordLabel: '비밀번호',
      passwordPlaceholder: '비밀번호를 입력하세요',
      openNetwork: '(개방형 네트워크 — 입력할 필요 없음)',
      toggleReveal: '비밀번호 표시 전환',
      kicker: '{ssid}의 비밀번호를 입력하세요',
      fetchHint: '연결되면 보드가 {url} 주소를 가져옵니다.',
      noUrlHint:
        '스냅숏 주소를 지정하지 않았습니다. 보드는 기본 데모 데이터를 표시합니다. 주소는 나중에 설정에서 추가할 수 있습니다.',
      connecting: '{ssid}에 연결하는 중입니다… 최대 1분이 걸릴 수 있습니다.',
      join: '연결',
      errors: {
        network: '보드와의 연결이 끊겼습니다. 보드의 설정용 Wi-Fi에 계속 접속되어 있는지 확인하세요.',
        passTooLong: '비밀번호가 너무 깁니다. 최대 64자까지 입력할 수 있습니다.',
        ssid: 'Wi-Fi 이름을 확인한 뒤 다시 시도하세요.',
        newsUrl: '보드가 스냅숏 주소를 거부했습니다. 이전 단계로 돌아가 주소를 확인하세요.',
        tooLarge: '보드가 받아들이기에 내용이 너무 깁니다. 스냅숏 주소를 줄인 뒤 다시 시도하세요.',
        provision: '설정을 보내는 중 문제가 발생했습니다. 다시 시도해 주세요.',
        unknown: '문제가 발생했습니다. 다시 시도해 주세요.',
        authFailed: '비밀번호가 맞지 않습니다. 확인한 뒤 다시 시도해 주세요.',
        joinFailed: '보드가 해당 네트워크에 접속하지 못했습니다. 다시 시도해 주세요.',
      },
    },
    complete: {
      title: '설정 완료',
      connectedTo: '보드가 ‘{ssid}’에 연결되었습니다.',
      connected: '보드가 연결되었습니다.',
      guidance:
        '휴대폰을 같은 Wi-Fi 네트워크에 다시 연결한 다음, 보드 열기를 눌러 집 네트워크에서 보드를 제어하세요.',
      cta: '보드 열기',
      ctaBusy: '여는 중…',
    },
  },

  noBoard: {
    title: '아직 보드가 없습니다',
    body: 'Claude Post는 하루에 한 기업을 13.3인치 전자종이에 인쇄합니다. 보드가 없어도 관심종목, 차트, 종목 검색은 모두 사용할 수 있습니다.',
    setAside: '이전에 설정을 미뤄 두셨습니다. 원하실 때 언제든 이어서 하실 수 있습니다.',
    alreadyHaveOne: '이미 이 네트워크에 보드가 있습니다',
    notFound: '이 Wi-Fi에서 보드를 찾지 못했습니다.',
  },

  common: {
    tryAgain: '다시 시도',
    retry: '재시도',
    cancel: '취소',
    refresh: '새로고침',
  },

  // 한국어는 달 이름을 줄이지 않고 번호로 부르므로, 이 열두 값은 철자가 아니라 번역이다.
  months: {
    short: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  },

  format: {
    pages: {
      front: 'A1 1면',
      accounts: 'A2 재무제표',
      other: '{n}페이지',
    },
    // 어순이 영어와 반대다. 영어는 수 뒤에 ago가 붙지만 한국어는 "{n}분 전"으로 수와 단위가
    // 붙고 전이 따라온다 — 자리표시자를 이름으로 채우는 이유가 그대로 드러나는 자리다.
    ago: {
      never: '한 번도 없음',
      now: '방금',
      seconds: '{n}초 전',
      minutes: '{n}분 전',
      hours: '{n}시간 전',
      days: '{n}일 전',
    },
    interval: {
      seconds: '{n}초마다',
      minutes: '{n}분마다',
      hours: '{n}시간마다',
    },
    // {month}는 위의 '8월' 같은 값이므로 "8월 4일"로 읽힌다.
    dateShort: '{month} {day}일',
    dateShortYear: '{year}년 {month} {day}일',
    generatedAt: '{year}년 {month} {day}일 {time}',
    fetchLabel: {
      ok: '동기화됨',
      notModified: '최신',
      noUrl: '데모',
      transport: '연결 불가',
      httpStatus: '서버 오류',
      badPayload: '잘못된 응답',
      unknown: '알 수 없음',
    },
    fetchMessage: {
      ok: '마지막 확인에 성공했습니다.',
      notModified: '보드가 확인했고 데스크는 바뀐 것이 없다고 답했습니다. 정상적인 확인입니다.',
      noUrl: '에디션 주소가 없어 보드가 기본 데모 에디션을 표시하고 있습니다.',
      transport: '해당 주소에 연결하지 못했습니다. 주소를 제공하는 컴퓨터가 켜져 있고 같은 네트워크에 있는지 확인하세요.',
      httpStatus: '서버가 응답했지만 오류였습니다. 주소의 경로를 확인하세요.',
      badPayload: '서버가 에디션이 아닌 것을 보냈습니다.',
      unknown: '보드가 이 앱이 알지 못하는 결과를 보고했습니다.',
    },
    pollSource: {
      policy: '데스크가 지정',
      board: '보드에 내장된 값',
    },
    sleepSource: {
      policy: '데스크가 지정',
      api: '이 앱에서 지정',
      nvs: '초기 설정에서 지정',
      default: '보드에 내장된 기본값',
    },
  },

  freshness: {
    minutes: '{n}분 전 업데이트',
    hours: '{n}시간 전 업데이트',
    yesterday: '어제 마지막 업데이트',
    date: '{month} {day}일 마지막 업데이트',
  },

  errors: {
    device: {
      timeout:
        '응답이 없습니다. 보드가 절전 중일 가능성이 큽니다. 보드는 몇 초씩만 깨어나고 그 사이에는 서버를 켜지 않습니다. 보드의 버튼을 누른 뒤 다시 시도하세요.',
      networkError: '보드에 연결하지 못했습니다. 전원이 켜져 있고 같은 Wi-Fi에 있는지 확인하세요.',
      pageRange: '그런 지면은 없습니다. 보드에는 두 면뿐입니다. A1은 1면, A2는 재무제표입니다.',
      newsUrlInvalid: '보드가 그 주소를 받아들이지 않았습니다.',
      sleepSecondsInvalid: '보드는 60초에서 24시간 사이의 값, 또는 내장 기본값을 뜻하는 0을 받습니다.',
      busy: '보드가 화면을 다시 그리는 중입니다. 이 패널은 한 번 갱신에 20~30초가 걸리니 그 뒤에 다시 시도하세요.',
      noFramebuffer: '보드가 응답하지만 아직 시작을 마치지 못했습니다. 잠시 기다려 주세요.',
      screenSize: '지면이 잘못된 크기로 돌아왔습니다. 내려받다 끊긴 것이니 다시 시도하세요.',
      screenFormat: '이 보드가 앱이 모르는 화면 형식을 보내고 있습니다. 앱을 업데이트하세요.',
      badJson: '보드가 요청을 읽지 못했습니다. 사용자의 잘못이 아니라 앱의 결함입니다.',
      tooLarge: '보드가 받아들이기에 내용이 너무 깁니다.',
      readError: '보드가 요청을 도중에 놓쳤습니다. 다시 시도하세요.',
      ssidEmpty: 'Wi-Fi 네트워크를 먼저 선택하세요.',
      ssidTooLong: '네트워크 이름이 보드가 저장할 수 있는 길이를 넘습니다.',
      passTooLong: '비밀번호가 보드가 저장할 수 있는 길이를 넘습니다.',
      httpError: '보드가 오류로 응답했습니다. 잠시 뒤 다시 시도하세요.',
      unknown: '명령을 실행하지 못했습니다. 다시 시도해 주세요.',
    },
    newsUrl: {
      tooLong: '주소가 너무 깁니다. 보드는 최대 {max}자까지 저장합니다.',
      badScheme: '주소는 http:// 또는 https://로 시작해야 합니다.',
      noHost: '주소에 호스트가 없습니다. 예: http://mymac.local:8123/news.json',
      invalid: '올바른 주소로 보이지 않습니다.',
    },
    edition: {
      noUrl: '에디션 주소가 아직 없습니다. 설정에서 추가하세요.',
      transport: '에디션 서버에 연결하지 못했습니다. 연결을 확인한 뒤 당겨서 새로고침하세요.',
      http: '에디션 서버가 오류로 응답했습니다.',
      httpStatus: '에디션 서버가 {status} 오류로 응답했습니다.',
      tooLarge: '에디션이 너무 커서 여기에서 읽을 수 없습니다.',
      badJson:
        '에디션을 해석하지 못했습니다. 데스크가 발행 중일 수 있으니 잠시 뒤 당겨서 새로고침하세요.',
      unknown: '에디션을 읽는 중 문제가 발생했습니다.',
    },
    desk: {
      unauthorized:
        '데스크가 이 토큰을 받아들이지 않았습니다. 신문 언어를 바꾸려면 operator 토큰이 필요합니다. producer 토큰으로는 설정을 읽을 수만 있습니다.',
      transport: '데스크에 연결하지 못했습니다. 주소와 네트워크 연결을 확인하세요.',
      http: '데스크가 오류로 응답했습니다.',
      httpStatus: '데스크가 {status} 오류로 응답했습니다.',
      refused: '데스크가 받아들이지 않았습니다: {detail}',
      badJson: '그 주소는 응답했지만 데스크의 응답이 아닙니다. 주소를 확인한 뒤 다시 시도하세요.',
      unknown: '데스크와 통신하는 중 문제가 발생했습니다.',
    },
    market: {
      transport: 'Yahoo Finance에 연결하지 못했습니다. 네트워크 연결을 확인하세요.',
      http: 'Yahoo Finance가 오류로 응답했습니다. 잠시 뒤 다시 시도하세요.',
      rateLimited: 'Yahoo가 요청 수를 제한하고 있습니다. 잠시 뒤 다시 시도하세요.',
      crumb: 'Yahoo가 지금은 상세 데이터를 제한하고 있습니다. 가격과 뉴스는 그대로 표시됩니다.',
      parse: 'Yahoo가 이 앱이 이해하지 못하는 응답을 보냈습니다.',
      notFound: '해당 종목의 데이터가 없습니다.',
      unknown: 'Yahoo Finance와 통신하는 중 문제가 발생했습니다.',
    },
  },

  board: {
    connecting: '연결 중…',
    loading: '불러오는 중…',
    unreachable: '보드에 연결하지 못했습니다.',
    commandFailed: '명령을 실행하지 못했습니다. 다시 시도해 주세요.',
    chips: {
      demo: '데모 에디션',
      stale: '지연',
      sleeps: '절전',
    },
    hero: {
      none: '아직 에디션이 없습니다',
      noneBody:
        '보드가 시작된 뒤로 에디션을 읽지 못했습니다. 아래 내용은 지면이 아니라 보드 자체를 설명합니다.',
    },
    sections: {
      headlines: '헤드라인',
      panel: '지면',
      source: '소스',
      power: '전원',
    },
    counts: {
      stories: '기사 {n}건',
      figures: '수치 {n}개',
      briefs: '단신 {n}건',
      peers: '동종 업계 {n}개',
      tables: '표 {n}개',
      charts: '차트 {n}개',
      photos: '사진 {n}장',
    },
    panel: {
      switching: '전환 중… 지면을 바꾸면 전체를 다시 그리므로 20~30초가 걸립니다.',
      // 조사는 앞말의 받침에 따라 달라지는데 {page}와 {ms}는 실행 시점에 정해지는 값이라
      // 어느 쪽이 올지 알 수 없다. 그래서 값 뒤에 조사를 붙이지 않는 형태로 문장을 끊는다.
      showing: '현재 지면: “{page}”. 이 패널의 마지막 갱신에 {ms} 걸렸습니다.',
      seeOnGlass: '인쇄된 지면 보기',
    },
    source: {
      url: '주소',
      notSet: '없음 (데모)',
      lastPoll: '마지막 확인',
      lastSuccess: '마지막 성공',
      polls: '확인 주기',
      note: '주소 자체는 설정 탭에서 바꿉니다.',
    },
    power: {
      deepSleep: '딥 슬립',
      on: '켜짐',
      off: '꺼짐',
      wakes: '깨어나는 주기',
      sinceUnplug: '마지막 분리 이후',
      wakeCounts: '{wakes}회 깨어남 (조용한 깨어남 {quiet}회)',
      notSleptYet: '아직 잠든 적 없음',
      awakeEach: '한 번에 깨어 있는 시간',
      battery: '배터리',
      notFitted: '장착되지 않음',
      estimate:
        '하루 약 {mah} mAh입니다. 깨어 있는 시간만 계산한 값으로, 갱신 한 번에 드는 2.3 mAh와 절전 중 대기 전류는 아직 이 보드에서 측정된 적이 없어 빠져 있습니다. 실제 값은 이보다 클 것입니다.',
      noEstimate:
        '아직 추정할 수 없습니다. 평균을 내려면 보드가 최소 한 번은 잠들어야 합니다. 1분이 아니라 하루를 벽에 걸어 둔 뒤에 읽으세요.',
    },
    sleep: {
      title: '얼마나 자주 깨어날지',
      presets: ['5분', '15분', '30분', '1시간', '6시간', '기본값'],
      deskDriving:
        '지금은 데스크가 주기를 정하고 있어, 지정하신 값은 저장된 채 대기합니다.',
      fallback:
        '데스크가 주기에 대해 아무 말도 하지 않을 때 보드가 쓰는 값입니다. 15분보다 짧으면 배터리가 눈에 띄게 빨리 줄어듭니다. “기본값”은 결정을 펌웨어에 되돌립니다.',
      sleepOff:
        '이 보드는 딥 슬립이 꺼져 있습니다. 콘솔이 연결된 USB 전원에서는 전혀 잠들지 않으므로, 이 설정은 배터리로 동작할 날을 위해 저장만 됩니다.',
    },
    actions: {
      pollNow: '지금 확인',
      selfTest: '자가 진단',
      note: '확인은 에디션이 바뀐 경우에만 화면을 다시 그립니다. 자가 진단은 약 1분 30초 동안 패널을 훑으며, 그동안 보드는 다른 요청에 응답하지 않습니다.',
    },
  },

  preview: {
    title: '지금 인쇄된 면',
    sheet: '보드에 현재 인쇄되어 있는 지면',
    readFailed: '보드에서 지면을 읽어 오지 못했습니다.',
    note: '프레임버퍼 자체를 측정된 잉크 색으로 보여 줍니다. 그리는 도중에 받아온 화면은 이전 에디션과 다음 에디션이 섞여 보일 수 있습니다. 패널이 아니라 내려받기 때문이니 다시 받아오세요.',
    staleNote: '위 지면은 마지막으로 받아온 화면이며, 새로 읽어 온 것이 아닙니다.',
    fetchAgain: '다시 받아오기',
    reading: '보드에서 960,000바이트를 읽어 그리는 중입니다.',
    nothingYet: '아직 받아온 지면이 없습니다.',
    awakeWindow:
      '배터리로 동작하는 보드는 깨어 있는 동안에만 응답합니다. 보드의 버튼을 누르면 몇 분간 깨어 있고, 요청이 올 때마다 그 시간이 다시 시작됩니다.',
  },

  markets: {
    title: '시세',
    addTicker: '종목 추가',
    remove: '삭제',
    removeSymbol: '{symbol} 삭제',
    emptyTitle: '첫 종목을 추가해 보세요',
    emptyBody: '종목을 검색하면 실시간 가격과 차트가 여기에 표시됩니다.',
    addATicker: '종목 추가하기',
  },

  addTicker: {
    searchPlaceholder: '검색',
    clearSearch: '검색어 지우기',
    placeholder: '종목 코드 또는 회사명',
    idle: 'Yahoo Finance에서 상장 종목을 검색하세요.',
    noMatches: '검색 결과가 없습니다.',
    addToWatchlist: '{symbol} 관심종목에 추가',
    removeFromWatchlist: '{symbol} 관심종목에서 삭제',
  },

  marketDetail: {
    tabs: {
      info: '개요',
      news: '뉴스',
      calendar: '일정',
      options: '옵션',
    },
    todaySuffix: '오늘',
    noChartData: '차트 데이터가 없습니다',
    info: {
      unavailable: '상세 지표를 불러올 수 없습니다',
      stats: '주요 지표',
      about: '기업 정보',
      open: '시가',
      high: '고가',
      low: '저가',
      volume: '거래량',
      avgVolume: '평균 거래량',
      divYield: '배당수익률',
      wk52High: '52주 최고',
      wk52Low: '52주 최저',
      marketCap: '시가총액',
      pe: 'PER',
      // 같은 화면의 calendar.epsActualVsEstimate가 'EPS'로 적는다. 한국 증권사 화면도
      // 주당순이익보다 EPS로 적는 쪽이 흔하므로 둘을 EPS로 맞춘다.
      eps: 'EPS',
      beta: '베타',
      employees: '임직원 {n}명',
      readMore: '더 보기',
      showLess: '접기',
    },
    news: {
      unavailable: '뉴스를 불러올 수 없습니다',
      empty: '{symbol}의 최근 뉴스가 없습니다.',
    },
    calendar: {
      unavailable: '일정을 불러올 수 없습니다',
      upcoming: '예정',
      empty: '예정된 일정이 없습니다.',
      pastEarnings: '지난 실적',
      earnings: '실적 발표',
      estimatedDate: '예상일',
      exDividend: '배당락일',
      dividendPayable: '배당 지급일',
      epsActualVsEstimate: 'EPS {actual} · 예상 {estimate}',
    },
    options: {
      unavailable: '옵션을 불러올 수 없습니다',
      switchError: '해당 만기를 불러오지 못해 {date} 만기를 그대로 표시합니다. {reason}',
      calls: '콜',
      puts: '풋',
      emptyCalls: '이 만기에는 콜 옵션이 없습니다.',
      emptyPuts: '이 만기에는 풋 옵션이 없습니다.',
      showAll: '전체 행사가 보기',
      showFewer: '접기',
      putCallRatio: '풋/콜 비율 (미결제)',
      maxPain: '맥스페인',
      impliedVolatility: '내재변동성',
      ivBothSides: '콜 {calls} · 풋 {puts}',
      strike: '행사가',
      bidAsk: '매수 / 매도',
      // 좁은 칸에 한 줄로 들어가야 해서 가운뎃점 양옆의 공백을 뺐다. 위의 iv와 같은 이유다.
      volOi: '거래량·미결제',
      // 좁은 칸에 한 줄로 들어가야 해서 '내재변동성'을 줄인 말이다. 위의 impliedVolatility는
      // 요약 행이라 자리가 있어 전체 표기를 쓴다.
      iv: '변동성',
    },
  },

  today: {
    notInEdition: '오늘 에디션에 없는 항목입니다.',
    more: '이 에디션의 다른 꼭지',
    demoChip: '데모 에디션',
    chips: {
      all: '전체',
      stories: '기사',
      numbers: '수치',
      accounts: '재무',
      photos: '사진',
    },
    heads: {
      range: '가격 범위',
      briefs: '단신',
      peers: '동종 업계',
      tape: '주요 지수',
      figures: '수치',
      chart: '차트',
      statement: '재무제표',
    },
    range: {
      weeks52: '52주',
      open: '시가',
      prevClose: '전일 종가',
      high: '고가',
      low: '저가',
      previousClose: '전일 종가',
      dayHigh: '당일 고가',
      dayLow: '당일 저가',
      wk52High: '52주 최고가',
      wk52Low: '52주 최저가',
    },
    andMore: '외 {n}개',
    a11y: {
      photograph: '사진',
      photographCaption: '사진. {caption}',
      range: '{symbol}의 가격 범위',
      chart: '차트, {label}, {span}',
      figures: '{group}, 수치 {n}개',
      briefs: '단신 {n}건',
      peers: '동종 업계 {n}개',
    },
  },
}
