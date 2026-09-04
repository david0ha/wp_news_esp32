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
}
