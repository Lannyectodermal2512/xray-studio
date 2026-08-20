import { useSyncExternalStore } from 'react'

/**
 * Interface language.
 *
 * A hand-rolled catalogue rather than i18next: this app has one screen's worth of
 * strings, no plural rules beyond a couple of counts, no lazy-loaded namespaces and no
 * translation pipeline. A dependency would add a build step and a runtime to solve
 * problems this does not have.
 *
 * English is the source. Every key exists in English by construction — the Russian
 * catalogue is typed against it, so a missing translation is a compile error rather
 * than a blank label discovered by a user.
 */

export type Lang = 'en' | 'ru'

const STORAGE_KEY = 'xray-studio.lang'

/** Everything the UI says, in the language it was written in. */
export const en = {
  'app.name': 'Xray Studio',

  /* ── topbar ─────────────────────────────────────────────────────────────── */
  'topbar.openConfig': 'Open config…',
  'topbar.pasteJson': 'Paste JSON…',
  'topbar.pasteJsonTitle': 'Paste config JSON instead of opening a file',
  'topbar.noConfig': 'no config',
  'topbar.reload': 'Reload',
  'topbar.reloadTitle': 'the file changed on disk',
  'topbar.start': 'Start',
  'topbar.stop': 'Stop',
  'topbar.eventsPerSec': 'events per second from the sidecar',
  'topbar.dropped': 'drop {n}',
  'topbar.droppedTitle':
    'Events dropped by the bounded event queue. Anything above zero means the UI is not seeing everything.',
  'topbar.chaosOff': 'Chaos off',
  'topbar.chaosOffTitle': 'Disable every fault at once',
  'topbar.dismiss': 'dismiss',
  'topbar.language': 'Language',

  /* ── state ──────────────────────────────────────────────────────────────── */
  'state.running': 'running',
  'state.stopped': 'stopped',
  'state.starting': 'starting',
  'state.error': 'error',

  /* ── tabs ───────────────────────────────────────────────────────────────── */
  'tab.observe': 'Observe',
  'tab.graph': 'Graph',
  'tab.editor': 'Editor',
  'tab.faults': 'Faults',
  'tab.whatif': 'What-if',
  'tab.validate': 'Validate',
  'tab.selfcheck': 'Self-check',
  'tab.reference': 'Reference',
  'tab.protocols': 'Protocols',
  'tab.log': 'Log',

  /* ── sidebar ────────────────────────────────────────────────────────────── */
  'rail.outbounds': 'Outbounds',
  'rail.balancers': 'Balancers',
  'rail.scale': 'scale 0–{n}ms',
  'rail.scaleTitle':
    'All sparklines share this ceiling, so their heights are comparable between rows.',
  'rail.noOutbounds': 'No outbounds seen yet.',
  'rail.noBalancers': 'No balancers seen yet.',
  'rail.dead': '{n}/{total} dead',
  'rail.deadTitle': "reported dead by the observatory, out of the group's total",
  'rail.fault': '{n} fault',
  'rail.faultTitle': 'outbounds with a fault injected',
  'rail.probesInFlight': 'probes in flight',
  'rail.faultActive': 'fault injected: {kind}',
  'rail.edit': 'edit',
  'rail.editTitle': 'Edit {tag} in the graph',
  'rail.untagged':
    'Dials made outside any outbound — the connectivity check and the built-in DNS client both do this. They cannot be edited or faulted by tag.',
  'rail.statusAlive': 'alive',
  'rail.statusDead': 'dead',
  'rail.statusNeverProbed': 'never probed — the observatory has no record of this outbound',

  /* ── observe ────────────────────────────────────────────────────────────── */
  'observe.rtt': 'RTT',
  'observe.logScale': 'log scale',
  'observe.autoLog':
    'Log scale applied automatically: one probe is far slower than the rest, and on a linear axis it would flatten everything else. Uncheck to compare.',
  'observe.noSamples':
    'No samples yet. The chart fills as the observatory probes; every probe, failed or not, also appears in the lane beneath it.',
  'observe.probes': 'probes',
  'observe.success': 'success',
  'observe.failure': 'failure',
  'observe.probesHint':
    'live outbounds are highlighted; a failed probe has no RTT, so it cannot appear on the chart',
  'observe.legendFoot':
    'Values are the most recent sample in milliseconds. Click a name to hide its line, a group heading to hide all of it.',
  'observe.solo': 'solo',

  /* ── observe: table and cards ───────────────────────────────────────────── */
  'observe.probeResults': 'Probe results',
  'observe.colOutbound': 'outbound',
  'observe.colAlive': 'alive',
  'observe.colDelay': 'delay',
  'observe.colAvg': 'avg',
  'observe.colDeviation': 'deviation',
  'observe.colMinMax': 'min / max',
  'observe.colFail': 'fail',
  'observe.colSamples': 'samples',
  'observe.colLastError': 'last error',
  'observe.yes': 'yes',
  'observe.no': 'no',
  'observe.untested': 'untested',
  'observe.untestedTitle': 'never probed — invisible to leastPing/leastLoad',
  'observe.deadMarker':
    'Not a measurement: the observatory stores 99999999 as its dead marker.',
  'observe.subMs': 'Delay truncates to whole milliseconds, so sub-1ms reads as 0',
  'observe.noProbes':
    'No probe results yet. The observatory probes on its own schedule — give it one interval.',
  'observe.balancers': 'Balancers',
  'observe.noBalancerRun':
    'No balancer has run yet. They evaluate once per dispatched connection, so send traffic through an inbound that routes to a balancerTag.',
  'observe.whyThisOutbound': 'Why this outbound?',
  'observe.noCandidates': 'no candidates',
  'observe.fallback': 'fallback {tag}',
  'observe.evals': '{n} evals',

  /* ── faults ─────────────────────────────────────────────────────────────── */
  'faults.inject': 'Inject a fault',
  'faults.pickOutbounds': 'Outbounds — click to build a group',
  'faults.tagsPlaceholder': 'LTE-1, LTE-4, REGULAR-*   (empty = all)',
  'faults.failureMode': 'Failure mode',
  'faults.arm': 'Arm fault',
  'faults.none': 'No faults. Everything is behaving normally.',
  'faults.active': 'Active faults',
  'faults.hardDown': 'also tears down existing connections',
  'faults.neverFires': 'this rule can never fire as written',
  'faults.cannotReproduce': 'What these faults cannot reproduce',
  'faults.selectAll': 'all',
  'faults.selectNone': 'none',
  'faults.selectInvert': 'invert',
  'faults.willHit': 'Will apply to: {tags}',
  'faults.willHitNone': 'Matches no outbound in this config — the rule would never fire.',
  'faults.matchesNothing': 'matches nothing',
  'faults.remove': 'remove',
  'faults.enabled': 'on',
  'faults.disabled': 'off',

  /* ── log ────────────────────────────────────────────────────────────────── */
  'log.files': 'Log files',
  'log.filesSub': 'written by this instance',
  'log.access': 'access',
  'log.error': 'error',
  'log.copy': 'copy',
  'log.filesNote':
    'These are set by Xray Studio, not by the config. The config file itself is never modified.',
  'log.coreLog': 'Core log',
  'log.andAbove': '{severity} and above',
  'log.nothingAtLevel': 'Nothing at this level.',

  /* ── editor ─────────────────────────────────────────────────────────────── */
  'editor.openToEdit': 'Open a config to edit it.',
  'editor.loading': 'Loading…',
  'editor.unsaved': 'unsaved',
  'editor.checking': 'checking…',
  'editor.errorCount': '{n} error',
  'editor.dysfunctionCount': '{n} silently broken',
  'editor.dysfunctionTitle': 'Parses, but does not do what it looks like it does.',
  'editor.clean': 'clean',
  'editor.savedAt': 'saved {time}',
  'editor.revert': 'Revert',
  'editor.save': 'Save to file',
  'editor.saveTitle': 'Write to disk (⌘S)',
  'editor.fixSyntaxFirst': 'Fix the syntax error first',
  'editor.reloadNote':
    'The running instance keeps the config it started with. Saving writes the file; press Reload in the header to restart Xray against it — a config only takes effect by starting a fresh process.',
  'editor.empty': 'Empty.',

  /* ── assistant ──────────────────────────────────────────────────────────── */
  'ai.title': 'Assistant',
  'ai.contextChars': '{n}k chars of context',
  'ai.setup': 'Setup',
  'ai.hideSetup': 'Hide setup',
  'ai.optConfig': 'config',
  'ai.optTelemetry': 'telemetry',
  'ai.optRedact': 'mask secrets',
  'ai.optConfigHelp': 'Send the config text with the first message.',
  'ai.optTelemetryHelp':
    'Send live state: liveness, delays, deviation, the balancer decision funnel, armed faults and recent log lines.',
  'ai.optRedactHelp':
    'Replace UUIDs, passwords and Reality keys with a marker of the same length. The model still sees that the field exists and is well-formed.',
  'ai.keyPrompt':
    'Paste an API key for {provider}. It is encrypted with your OS keychain and kept in the main process — the window never sees it, and it is never written to the project.',
  'ai.saveKey': 'Save key',
  'ai.emptyIntro':
    'Asks are answered against this config and the running instance: which outbounds the observatory calls alive, their deviation, the reason the balancer rejected each candidate, and any faults you have armed.',
  'ai.emptyExamples':
    'Try: “why is nothing being selected?” · “what does costs 5000 do here?” · “this outbound is never picked — why?”',
  'ai.you': 'you',
  'ai.assistant': 'assistant',
  'ai.placeholder': 'Ask about this config…  (⏎ to send, ⇧⏎ for a new line)',
  'ai.placeholderNoKey': 'Set an API key first',
  'ai.send': 'Send',
  'ai.stop': 'Stop',

  /* ── graph ──────────────────────────────────────────────────────────────── */
  'graph.structure': 'Structure',
  'graph.openToSee': 'Open a config to see its structure.',
  'graph.parsing': 'Parsing…',
  'graph.parseFailed': 'Could not parse the config for display: {err}',
  'graph.clickToEdit': 'click a node to edit',
  'graph.readOnly': 'read-only',
  'graph.hint': 'scroll or drag to pan · pinch or ⌘-scroll to zoom · drag a heading to move its group',
  'graph.gap': 'gap',
  'graph.gapTitle':
    'Widens the gap BETWEEN COLUMNS. Every edge crosses that gap, so it is the only dimension where more room buys legibility; row height is fixed because taller rows tell you nothing new.',
  'graph.fit': 'Fit',
  'graph.fitTitle': 'Frame everything',
  'graph.resetMoves': 'Reset moves',
  'graph.resetMovesTitle': 'Put every group back where the layout put it',

  /* ── what-if ────────────────────────────────────────────────────────────── */
  'whatif.title': 'What if…',
  'whatif.noBalancer':
    'No balancer in this config. Add a routing.balancers entry to see what it would choose.',
  'whatif.recapture': 'Re-capture observation',
  'whatif.intro':
    'Answers come from the sidecar running the real strategy code against the observation below — not from a model of it. Balancer {tag}, strategy {strategy}.',
  'whatif.off': 'off',
  'whatif.kill': 'kill',
  'whatif.deterministic': 'deterministic',
  'whatif.notDeterministic': 'not deterministic',

  /* ── validate ───────────────────────────────────────────────────────────── */
  'validate.openToValidate': 'Open a config to validate it.',
  'validate.recheck': 'Re-check',
  'validate.clean': 'clean',
  'validate.checking': 'checking…',
  'validate.intro':
    'Xray already rejects malformed configs. What it will not tell you about is the config it accepts and then does not act on.',
  'validate.nothingFound': 'Nothing to report — this config does what it looks like it does.',

  /* ── paste dialog ───────────────────────────────────────────────────────── */
  'paste.title': 'Paste config JSON',
  'paste.close': 'close',
  'paste.cancel': 'Cancel',
  'paste.use': 'Use this config',
  'paste.parses': 'Parses. {out} outbound(s), {in} inbound(s).',
  'paste.empty': 'Paste a config to check it.',

  /* ── shared ─────────────────────────────────────────────────────────────── */
  'common.none': '(none)',
  'common.never': 'never',
  'common.dead': 'dead',
  'common.copy': 'copy',
} as const

export type Key = keyof typeof en

/**
 * Russian.
 *
 * Typed as Record<Key, string>, so adding an English string without its translation
 * fails the build instead of surfacing as an untranslated label in someone's UI.
 */
export const ru: Record<Key, string> = {
  'app.name': 'Xray Studio',

  'topbar.openConfig': 'Открыть…',
  'topbar.pasteJson': 'Вставить…',
  'topbar.pasteJsonTitle': 'Вставить JSON конфига вместо открытия файла',
  'topbar.noConfig': 'конфиг не выбран',
  'topbar.reload': 'Перезапустить',
  'topbar.reloadTitle': 'файл на диске изменился',
  'topbar.start': 'Старт',
  'topbar.stop': 'Стоп',
  'topbar.eventsPerSec': 'событий в секунду от сайдкара',
  'topbar.dropped': 'потеряно {n}',
  'topbar.droppedTitle':
    'События, отброшенные ограниченной очередью. Всё, что больше нуля, означает: интерфейс видит не всё.',
  'topbar.chaosOff': 'Снять сбои',
  'topbar.chaosOffTitle': 'Выключить все сбои разом',
  'topbar.dismiss': 'скрыть',
  'topbar.language': 'Язык',

  'state.running': 'работает',
  'state.stopped': 'остановлен',
  'state.starting': 'запускается',
  'state.error': 'ошибка',

  'tab.observe': 'Обзор',
  'tab.graph': 'Граф',
  'tab.editor': 'Редактор',
  'tab.faults': 'Сбои',
  'tab.whatif': 'Имитация',
  'tab.validate': 'Проверка',
  'tab.selfcheck': 'Самопроверка',
  'tab.reference': 'Справочник',
  'tab.protocols': 'Протоколы',
  'tab.log': 'Лог',

  'rail.outbounds': 'Outbounds',
  'rail.balancers': 'Балансировщики',
  'rail.scale': 'шкала 0–{n} мс',
  'rail.scaleTitle':
    'У всех спарклайнов общий потолок, поэтому их высоты сравнимы между строками.',
  'rail.noOutbounds': 'Outbounds пока не видно.',
  'rail.noBalancers': 'Балансировщиков пока не видно.',
  'rail.dead': '{n}/{total} мертвы',
  'rail.deadTitle': 'признаны мёртвыми обсерваторией, из общего числа в группе',
  'rail.fault': '{n} со сбоем',
  'rail.faultTitle': 'outbounds с внедрённым сбоем',
  'rail.probesInFlight': 'проб в полёте',
  'rail.faultActive': 'внедрён сбой: {kind}',
  'rail.edit': 'править',
  'rail.editTitle': 'Открыть {tag} в графе',
  'rail.untagged':
    'Дозвоны вне какого-либо outbound — так делают проверка связности и встроенный DNS-клиент. Их нельзя ни править, ни ломать по тегу.',
  'rail.statusAlive': 'жив',
  'rail.statusDead': 'мёртв',
  'rail.statusNeverProbed': 'ни разу не пробовался — у обсерватории нет о нём записи',

  'observe.rtt': 'RTT',
  'observe.logScale': 'лог. шкала',
  'observe.autoLog':
    'Логарифмическая шкала включена автоматически: одна проба намного медленнее остальных, и на линейной оси она сплющила бы всё прочее. Снимите галочку для сравнения.',
  'observe.noSamples':
    'Замеров пока нет. График наполняется по мере проб; каждая проба, удачная или нет, попадает и в полосу под ним.',
  'observe.probes': 'пробы',
  'observe.success': 'успех',
  'observe.failure': 'отказ',
  'observe.probesHint':
    'живые outbounds подсвечены; у неудачной пробы нет RTT, поэтому на графике её быть не может',
  'observe.legendFoot':
    'Значения — последний замер в миллисекундах. Клик по имени скрывает его линию, по заголовку группы — всю группу.',
  'observe.solo': 'только эта',

  'observe.probeResults': 'Результаты проб',
  'observe.colOutbound': 'outbound',
  'observe.colAlive': 'жив',
  'observe.colDelay': 'задержка',
  'observe.colAvg': 'среднее',
  'observe.colDeviation': 'отклонение',
  'observe.colMinMax': 'мин / макс',
  'observe.colFail': 'отказы',
  'observe.colSamples': 'замеры',
  'observe.colLastError': 'последняя ошибка',
  'observe.yes': 'да',
  'observe.no': 'нет',
  'observe.untested': 'не пробовался',
  'observe.untestedTitle': 'ни разу не пробовался — невидим для leastPing и leastLoad',
  'observe.deadMarker':
    'Это не замер: обсерватория хранит 99999999 как признак смерти.',
  'observe.subMs': 'Задержка усекается до целых миллисекунд, поэтому меньше 1 мс читается как 0',
  'observe.noProbes':
    'Результатов проб пока нет. Обсерватория опрашивает по своему расписанию — дайте ей один интервал.',
  'observe.balancers': 'Балансировщики',
  'observe.noBalancerRun':
    'Ни один балансировщик ещё не отрабатывал. Они принимают решение на каждое диспетчеризованное соединение — пропустите трафик через inbound, у которого в правиле стоит balancerTag.',
  'observe.whyThisOutbound': 'Почему именно этот outbound?',
  'observe.noCandidates': 'нет кандидатов',
  'observe.fallback': 'fallback {tag}',
  'observe.evals': 'решений: {n}',

  'faults.inject': 'Внедрить сбой',
  'faults.pickOutbounds': 'Outbounds — кликом собрать группу',
  'faults.tagsPlaceholder': 'LTE-1, LTE-4, REGULAR-*   (пусто = все)',
  'faults.failureMode': 'Вид отказа',
  'faults.arm': 'Включить сбой',
  'faults.none': 'Сбоев нет. Всё ведёт себя штатно.',
  'faults.active': 'Действующие сбои',
  'faults.hardDown': 'также рвёт уже установленные соединения',
  'faults.neverFires': 'это правило в таком виде не сработает никогда',
  'faults.cannotReproduce': 'Чего эти сбои воспроизвести не могут',
  'faults.selectAll': 'все',
  'faults.selectNone': 'ни одного',
  'faults.selectInvert': 'инвертировать',
  'faults.willHit': 'Применится к: {tags}',
  'faults.willHitNone': 'Не совпадает ни с одним outbound в этом конфиге — правило не сработает.',
  'faults.matchesNothing': 'ничему не соответствует',
  'faults.remove': 'убрать',
  'faults.enabled': 'вкл',
  'faults.disabled': 'выкл',

  'log.files': 'Файлы логов',
  'log.filesSub': 'пишет этот экземпляр',
  'log.access': 'доступ',
  'log.error': 'ошибки',
  'log.copy': 'копировать',
  'log.filesNote':
    'Эти пути задаёт Xray Studio, а не конфиг. Сам файл конфига при этом не изменяется.',
  'log.coreLog': 'Лог ядра',
  'log.andAbove': '{severity} и выше',
  'log.nothingAtLevel': 'На этом уровне ничего нет.',

  'editor.openToEdit': 'Откройте конфиг, чтобы его править.',
  'editor.loading': 'Загрузка…',
  'editor.unsaved': 'не сохранено',
  'editor.checking': 'проверяю…',
  'editor.errorCount': 'ошибок: {n}',
  'editor.dysfunctionCount': 'молча не работает: {n}',
  'editor.dysfunctionTitle': 'Разбирается, но делает не то, чем выглядит.',
  'editor.clean': 'чисто',
  'editor.savedAt': 'сохранено в {time}',
  'editor.revert': 'Откатить',
  'editor.save': 'Сохранить в файл',
  'editor.saveTitle': 'Записать на диск (⌘S)',
  'editor.fixSyntaxFirst': 'Сначала исправьте синтаксическую ошибку',
  'editor.reloadNote':
    'Запущенный экземпляр продолжает работать с тем конфигом, с которым стартовал. Сохранение пишет файл; нажмите «Перезапустить» в шапке, чтобы поднять Xray заново — конфиг вступает в силу только с новым процессом.',
  'editor.empty': 'Пусто.',

  'ai.title': 'Ассистент',
  'ai.contextChars': '{n}k знаков контекста',
  'ai.setup': 'Настройка',
  'ai.hideSetup': 'Скрыть настройку',
  'ai.optConfig': 'конфиг',
  'ai.optTelemetry': 'телеметрия',
  'ai.optRedact': 'скрыть секреты',
  'ai.optConfigHelp': 'Отправлять текст конфига с первым сообщением.',
  'ai.optTelemetryHelp':
    'Отправлять живое состояние: жив ли хост, задержки, отклонение, воронку решения балансировщика, включённые сбои и последние строки лога.',
  'ai.optRedactHelp':
    'Заменять UUID, пароли и ключи Reality маркером той же длины. Модель по-прежнему видит, что поле есть и что оно правильной формы.',
  'ai.keyPrompt':
    'Вставьте ключ API для {provider}. Он шифруется системным хранилищем и живёт в главном процессе — окно его не видит, и в проект он не записывается.',
  'ai.saveKey': 'Сохранить ключ',
  'ai.emptyIntro':
    'Ответы строятся по этому конфигу и по работающему экземпляру: какие outbounds обсерватория считает живыми, их отклонение, причина отсева каждого кандидата и включённые вами сбои.',
  'ai.emptyExamples':
    'Например: «почему ничего не выбирается?» · «что здесь делает costs 5000?» · «этот outbound никогда не выбирают — почему?»',
  'ai.you': 'вы',
  'ai.assistant': 'ассистент',
  'ai.placeholder': 'Спросите об этом конфиге…  (⏎ — отправить, ⇧⏎ — новая строка)',
  'ai.placeholderNoKey': 'Сначала задайте ключ API',
  'ai.send': 'Отправить',
  'ai.stop': 'Прервать',

  'graph.structure': 'Структура',
  'graph.openToSee': 'Откройте конфиг, чтобы увидеть его структуру.',
  'graph.parsing': 'Разбираю…',
  'graph.parseFailed': 'Не удалось разобрать конфиг для отображения: {err}',
  'graph.clickToEdit': 'клик по узлу — правка',
  'graph.readOnly': 'только чтение',
  'graph.hint': 'скролл или перетаскивание — панорама · пинч или ⌘-скролл — зум · тянуть заголовок — двигать группу',
  'graph.gap': 'зазор',
  'graph.gapTitle':
    'Расширяет промежуток МЕЖДУ КОЛОНКАМИ. Каждое ребро пересекает этот промежуток, поэтому только здесь лишнее место даёт читаемость; высота строки фиксирована — более высокие строки ничего не сообщают.',
  'graph.fit': 'Вписать',
  'graph.fitTitle': 'Показать всё целиком',
  'graph.resetMoves': 'Сбросить сдвиги',
  'graph.resetMovesTitle': 'Вернуть все группы туда, куда их поставила раскладка',

  'whatif.title': 'Имитация',
  'whatif.noBalancer':
    'В этом конфиге нет балансировщика. Добавьте запись routing.balancers, чтобы увидеть, что он выберет.',
  'whatif.recapture': 'Снять наблюдение заново',
  'whatif.intro':
    'Ответы даёт сайдкар, прогоняя настоящий код стратегии против наблюдения ниже, а не его модель. Балансировщик {tag}, стратегия {strategy}.',
  'whatif.off': 'выкл',
  'whatif.kill': 'убить',
  'whatif.deterministic': 'детерминирован',
  'whatif.notDeterministic': 'не детерминирован',

  'validate.openToValidate': 'Откройте конфиг, чтобы его проверить.',
  'validate.recheck': 'Проверить заново',
  'validate.clean': 'чисто',
  'validate.checking': 'проверяю…',
  'validate.intro':
    'Xray и сам отвергает некорректные конфиги. О чём он не скажет — так это о конфиге, который он принимает, а потом не исполняет.',
  'validate.nothingFound': 'Замечаний нет — этот конфиг делает то, чем выглядит.',

  'paste.title': 'Вставьте JSON конфига',
  'paste.close': 'закрыть',
  'paste.cancel': 'Отмена',
  'paste.use': 'Использовать этот конфиг',
  'paste.parses': 'Разбирается. Исходящих: {out}, inbounds: {in}.',
  'paste.empty': 'Вставьте конфиг для проверки.',

  'common.none': '(нет)',
  'common.never': 'никогда',
  'common.dead': 'мёртв',
  'common.copy': 'копировать',
}

const CATALOGUES: Record<Lang, Record<Key, string>> = { en, ru }

/* ── the store ─────────────────────────────────────────────────────────────
   Deliberately not in the zustand app store: the language is a property of the
   installation rather than of the session, it has to be readable before React mounts,
   and keeping it separate means a language change cannot invalidate telemetry state. */

function initial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ru') return saved
  } catch {
    /* private mode, or storage disabled */
  }
  // Follow the system on first run, then never again — an explicit choice outranks it.
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

let current: Lang = initial()
const listeners = new Set<() => void>()

export function getLang(): Lang {
  return current
}

export function setLang(next: Lang): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    /* not fatal: the choice simply will not survive a restart */
  }
  document.documentElement.lang = next
  for (const l of listeners) l()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Translate.
 *
 * Substitutes {name} placeholders. Falls back to English for a key the active
 * catalogue somehow lacks, which cannot happen through the type system but can through
 * a hot reload mid-edit — and a visible English string beats a blank one.
 */
export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const s = CATALOGUES[lang][key] ?? en[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

export type T = (key: Key, vars?: Record<string, string | number>) => string

/** The hook every component uses. Re-renders on a language change, nothing else. */
export function useT(): { t: T; lang: Lang } {
  const lang = useSyncExternalStore(subscribe, getLang, getLang)
  return {
    lang,
    t: (key, vars) => translate(lang, key, vars),
  }
}
