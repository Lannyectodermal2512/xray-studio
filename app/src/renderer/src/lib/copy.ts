import type { RejectionReason, StageId, StageNote, FaultKind } from '@shared/events'
import { useT } from './i18n'

/**
 * Human wording for the stable machine codes the core emits.
 *
 * The codes never change and are never localised; all phrasing lives here. Several of
 * these exist to explain Xray behaviour that is genuinely surprising, so the text is
 * doing real work — it is not decoration.
 */

export const rejectionLabel: Record<RejectionReason, string> = {
  not_in_observation: 'never probed',
  not_alive: 'reported dead',
  maxrtt_exceeded: 'slower than maxRTT',
  tolerance_exceeded: 'failure rate above tolerance',
  not_in_candidates: 'outside this balancer',
  outranked: 'outranked',
  above_baseline: 'above every baseline',
  beyond_expected: 'beyond the expected count',
  not_chosen_by_dice: 'lost the random draw',
  not_current_index: 'not this rotation slot',
}

export const rejectionHelp: Record<RejectionReason, string> = {
  not_in_observation:
    'The observatory has no record of this outbound. leastPing and leastLoad iterate the observation, not the candidate list, so an outbound that has never been probed is invisible to them — it is not rejected, it simply never appears. Usually means the observatory subjectSelector does not cover it.',
  not_alive:
    'The observatory reports this outbound as down. Under burstObservatory "alive" means at least one success in the current sampling window (all != fail), not "the last probe succeeded".',
  maxrtt_exceeded:
    'Delay is at or above maxRTT. Note the comparison uses Delay — an integer number of milliseconds — not HealthPing.Average, so sub-millisecond differences are invisible here.',
  tolerance_exceeded:
    'fail/all exceeds tolerance. Only active with burstObservatory (it needs HealthPing), with all > 0 and tolerance > 0 — under the plain observatory the setting parses but does nothing.',
  not_in_candidates: 'Present in the observation, but not selected by this balancer.',
  outranked: 'Viable, but another candidate ranked strictly better.',
  above_baseline: 'Score did not fall below any configured baseline.',
  beyond_expected: 'Ranked below the truncation point set by expected.',
  not_chosen_by_dice:
    'Survived to the final step and lost a uniform random draw. This is not a defect: the last step of random and leastLoad is chance, not ranking.',
  not_current_index: 'Round-robin selected a different slot on this pass.',
}

export const stageLabel: Record<StageId, string> = {
  select: 'selector',
  observation: 'observatory',
  alive_filter: 'liveness',
  node_filter: 'filters',
  score: 'score',
  sort: 'rank',
  baseline: 'baseline / expected',
  expected: 'expected',
  min_scan: 'lowest delay',
  rr_index: 'rotation',
  dice: 'random draw',
}

export interface NoteCopy {
  text: string
  tone: 'info' | 'warn' | 'bad'
}

export const stageNote: Record<StageNote, NoteCopy> = {
  observatory_ignored_no_fallback: {
    tone: 'warn',
    text:
      'Observatory ignored — random and roundRobin only consult it when fallbackTag is set. Without one, dead outbounds are picked just as readily as live ones.',
  },
  observatory_nil: {
    tone: 'bad',
    text:
      'No observatory is available, so this strategy returns nothing for every request. leastPing and leastLoad require an observatory or burstObservatory block.',
  },
  observation_error: {
    tone: 'bad',
    text: 'Reading the observatory failed; the liveness filter was skipped entirely.',
  },
  no_health_ping: {
    tone: 'warn',
    text:
      'No HealthPing data — this is the plain observatory, not burstObservatory. leastLoad therefore uses raw delay as the deviation and degenerates into leastPing with a cost multiplier.',
  },
  unfound_assumed_alive: {
    tone: 'warn',
    text:
      'A candidate missing from the observation was kept: random and roundRobin treat "not found" as ALIVE, not dead.',
  },
  baseline_applied: { tone: 'info', text: 'A baseline produced enough survivors and stopped the walk.' },
  baseline_none_qualified: {
    tone: 'warn',
    text:
      'Speed-priority mode (baselines with expected <= 0): nothing qualified, so the balancer legitimately selects nothing and defers to fallbackTag.',
  },
  baselines_unsorted: {
    tone: 'warn',
    text: 'Baselines are walked in config order, not sorted. A non-ascending list wastes iterations.',
  },
  expected_floor_applied: {
    tone: 'info',
    text: 'The expected floor widened the selection past what the baselines qualified.',
  },
  tie: {
    tone: 'warn',
    text:
      'Two or more candidates tied on the deciding key. Under burstObservatory the tie order comes from Go map iteration, so the winner among equals is re-randomised on every call.',
  },
  rr_index_jumped: {
    tone: 'warn',
    text:
      'The candidate list changed length, so the modulo rotation jumped rather than advancing by one. Round-robin is not a stable cursor over a stable set.',
  },
  empty: { tone: 'bad', text: 'Nothing survived this stage.' },
  override_pinned: {
    tone: 'bad',
    text:
      'A manual override is pinned, bypassing the strategy entirely. It has no expiry, and it is not validated — pinning a tag that does not exist kills the connection rather than falling back.',
  },
  no_baselines: { tone: 'info', text: 'No baselines configured; expected alone decides the cut.' },
  expected_exceeds_available: {
    tone: 'info',
    text: 'expected is larger than the number of qualified outbounds, so all of them are kept.',
  },
}

export const sourceCopy: Record<string, NoteCopy> = {
  strategy: { tone: 'info', text: 'Chosen by the strategy.' },
  override: {
    tone: 'bad',
    text: 'Pinned by a manual override — the strategy did not run.',
  },
  fallback_empty: {
    tone: 'warn',
    text: 'The strategy returned nothing, so fallbackTag was used.',
  },
  fallback_select_error: {
    tone: 'warn',
    text: 'Selecting candidates failed, so fallbackTag was used.',
  },
  error: {
    tone: 'bad',
    text:
      'No tag and no fallbackTag. The dispatcher silently falls through to the DEFAULT outbound — the first one in the config.',
  },
}

export const faultLabel: Record<FaultKind, string> = {
  blackhole: 'Blackhole (drop)',
  refuse: 'Connection refused',
  host_unreachable: 'Host unreachable',
  net_unreachable: 'Network unreachable',
  dns_fail: 'DNS failure',
  tls_hang: 'TLS handshake hangs',
  tls_garbage: 'TLS garbage response',
  latency: 'Added latency',
  throttle: 'Bandwidth throttle',
  reset_after: 'Reset mid-connection',
  udp_loss: 'UDP packet loss',
}

export const faultHelp: Record<FaultKind, string> = {
  blackhole:
    'Packets vanish. The dial blocks until it times out, exactly like an iptables DROP or a whitelist that ignores you. Probes and real traffic both see it.',
  refuse: 'Immediate ECONNREFUSED, like a closed port or REJECT --reject-with tcp-reset.',
  host_unreachable: 'ICMP host unreachable — the route exists but the host does not answer.',
  net_unreachable: 'ICMP network unreachable — no route to the network at all.',
  dns_fail:
    'Resolution fails. Partial fidelity: depending on domainStrategy, resolution may already have happened before the dialer is reached.',
  tls_hang:
    'TCP connects, then nothing answers, so the TLS handshake times out. The classic "port open, service dead" shape — and the one most easily mistaken for a working server.',
  tls_garbage:
    'TCP connects and the server replies with noise, producing "first record does not look like a TLS handshake".',
  latency: 'Adds delay to the connect and to every read. Use it to make a balancer re-rank.',
  throttle: 'Token-bucket rate limit in both directions.',
  reset_after: 'Passes traffic, then tears the connection down with ECONNRESET.',
  udp_loss: 'Drops a percentage of datagrams. Meaningful for QUIC, KCP and hysteria.',
}

export function fmtMs(ns: number | undefined): string {
  if (!ns) return '—'
  const ms = ns / 1e6
  if (ms < 1) return `${(ns / 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * The plain observatory writes delay = 99999999 for a dead outbound rather than
 * leaving it unset, and the burst observatory uses rttFailed = MaxInt64. Neither is a
 * measurement, and rendering them as durations produces nonsense like "100000.00s".
 */
export const DEAD_DELAY_MS = 99_999_999

export function isDeadSentinel(ms: number | undefined): boolean {
  return ms !== undefined && ms >= DEAD_DELAY_MS
}

export function fmtMsFromMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—'
  if (isDeadSentinel(ms)) return 'dead'
  if (ms === 0) return '<1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/* ── Russian ────────────────────────────────────────────────────────────────
   Kept beside the English originals rather than moved into the i18n catalogue: these
   strings explain specific Xray behaviours, and a translation that drifts from the
   sentence it renders would be worse than none. Side by side, drift is visible in the
   diff.

   Domain terms stay in Latin — outbound, fallback, balancer names, strategy names —
   because that is what the official Russian documentation does and what the config
   itself says. */

export const rejectionLabelRu: Record<RejectionReason, string> = {
  not_in_observation: 'ни разу не пробовался',
  not_alive: 'признан мёртвым',
  maxrtt_exceeded: 'медленнее maxRTT',
  tolerance_exceeded: 'доля отказов выше tolerance',
  not_in_candidates: 'вне этого балансировщика',
  outranked: 'проиграл по рангу',
  above_baseline: 'выше всех baseline',
  beyond_expected: 'за пределом expected',
  not_chosen_by_dice: 'проиграл жеребьёвку',
  not_current_index: 'не этот слот ротации',
}

export const rejectionHelpRu: Record<RejectionReason, string> = {
  not_in_observation:
    'У обсерватории нет записи об этом outbound. leastPing и leastLoad идут по НАБЛЮДЕНИЮ, а не по списку кандидатов, поэтому ни разу не опрошенный outbound для них невидим — он не отсеян, его просто нет. Обычно это значит, что subjectSelector обсерватории его не покрывает.',
  not_alive:
    'Обсерватория считает этот outbound мёртвым. В burstObservatory «жив» означает хотя бы один успех в текущем окне выборки (all != fail), а не «последняя проба удалась».',
  maxrtt_exceeded:
    'Delay больше или равен maxRTT. Обратите внимание: сравнение идёт по Delay — целому числу миллисекунд, — а не по HealthPing.Average, поэтому разница меньше миллисекунды здесь не видна.',
  tolerance_exceeded:
    'fail/all превышает tolerance. Работает только с burstObservatory (нужен HealthPing), при all > 0 и tolerance > 0 — под обычной обсерваторией параметр разбирается, но ни на что не влияет.',
  not_in_candidates: 'Есть в наблюдении, но не выбран селектором этого балансировщика.',
  outranked: 'Годен, но другой кандидат оказался строго лучше.',
  above_baseline: 'Счёт не опустился ниже ни одного из заданных baseline.',
  beyond_expected: 'Оказался ниже точки отсечения, заданной expected.',
  not_chosen_by_dice:
    'Дожил до последнего шага и проиграл равномерную жеребьёвку. Это не дефект: последний шаг random и leastLoad — случайность, а не ранжирование.',
  not_current_index: 'На этом проходе round-robin выбрал другой слот.',
}

export const stageLabelRu: Record<StageId, string> = {
  select: 'селектор',
  observation: 'обсерватория',
  alive_filter: 'живость',
  node_filter: 'фильтры',
  score: 'счёт',
  sort: 'ранг',
  baseline: 'baseline / expected',
  expected: 'expected',
  min_scan: 'наименьшая задержка',
  rr_index: 'ротация',
  dice: 'жеребьёвка',
}

export const stageNoteRu: Record<StageNote, NoteCopy> = {
  observatory_ignored_no_fallback: {
    tone: 'warn',
    text:
      'Обсерватория проигнорирована — random и roundRobin обращаются к ней только при заданном fallbackTag. Без него мёртвые outbounds выбираются наравне с живыми.',
  },
  observatory_nil: {
    tone: 'bad',
    text:
      'Обсерватория недоступна, поэтому стратегия ничего не возвращает на каждый запрос. leastPing и leastLoad требуют блока observatory или burstObservatory.',
  },
  observation_error: {
    tone: 'bad',
    text: 'Чтение обсерватории не удалось; фильтр живости пропущен целиком.',
  },
  no_health_ping: {
    tone: 'warn',
    text:
      'Данных HealthPing нет — это обычная обсерватория, а не burstObservatory. Поэтому leastLoad берёт за отклонение сырую задержку и вырождается в leastPing с множителем стоимости.',
  },
  unfound_assumed_alive: {
    tone: 'warn',
    text:
      'Кандидат, отсутствующий в наблюдении, оставлен: random и roundRobin считают «не найден» ЖИВЫМ, а не мёртвым.',
  },
  baseline_applied: { tone: 'info', text: 'Baseline дал достаточно выживших и остановил проход.' },
  baseline_none_qualified: {
    tone: 'warn',
    text:
      'Режим приоритета скорости (baselines при expected <= 0): не прошёл никто, поэтому балансировщик законно не выбирает ничего и уходит в fallbackTag.',
  },
  baselines_unsorted: {
    tone: 'warn',
    text: 'Baseline обходятся в порядке из конфига, а не отсортированными. Невозрастающий список тратит итерации впустую.',
  },
  expected_floor_applied: {
    tone: 'info',
    text: 'Нижняя граница expected расширила выбор за пределы того, что прошло по baseline.',
  },
  tie: {
    tone: 'warn',
    text:
      'Два или более кандидата совпали по решающему ключу. В burstObservatory порядок при равенстве берётся из обхода Go-мапы, поэтому победитель среди равных заново случаен на каждом вызове.',
  },
  rr_index_jumped: {
    tone: 'warn',
    text:
      'Длина списка кандидатов изменилась, поэтому ротация по модулю прыгнула, а не сдвинулась на один. Round-robin — не устойчивый курсор по устойчивому множеству.',
  },
  empty: { tone: 'bad', text: 'Этот этап не пережил никто.' },
  override_pinned: {
    tone: 'bad',
    text:
      'Закреплён ручной override, стратегия обойдена целиком. У него нет срока давности и он не проверяется — закрепление несуществующего тега убивает соединение, а не уходит в fallback.',
  },
  no_baselines: { tone: 'info', text: 'Baseline не заданы; отсечение определяет один expected.' },
  expected_exceeds_available: {
    tone: 'info',
    text: 'Expected больше числа годных outbounds, поэтому оставлены все.',
  },
}

export const sourceCopyRu: Record<string, NoteCopy> = {
  strategy: { tone: 'info', text: 'Выбрано стратегией.' },
  override: { tone: 'bad', text: 'Закреплено ручным override — стратегия не запускалась.' },
  fallback_empty: { tone: 'warn', text: 'Стратегия не вернула ничего, поэтому взят fallbackTag.' },
  fallback_select_error: { tone: 'warn', text: 'Отбор кандидатов не удался, поэтому взят fallbackTag.' },
  error: {
    tone: 'bad',
    text:
      'Ни тега, ни fallbackTag. Диспетчер молча проваливается в outbound ПО УМОЛЧАНИЮ — первый в конфиге.',
  },
}

export const faultLabelRu: Record<FaultKind, string> = {
  blackhole: 'Чёрная дыра (drop)',
  refuse: 'Соединение отклонено',
  host_unreachable: 'Хост недоступен',
  net_unreachable: 'Сеть недоступна',
  dns_fail: 'Отказ DNS',
  tls_hang: 'TLS-рукопожатие виснет',
  tls_garbage: 'Мусор вместо TLS',
  latency: 'Добавленная задержка',
  throttle: 'Ограничение полосы',
  reset_after: 'Разрыв посреди соединения',
  udp_loss: 'Потеря UDP-пакетов',
}

export const faultHelpRu: Record<FaultKind, string> = {
  blackhole:
    'Пакеты исчезают. Дозвон висит до таймаута — ровно как при iptables DROP или белом списке, который вас игнорирует. Видят и пробы, и реальный трафик.',
  refuse: 'Немедленный ECONNREFUSED, как при закрытом порте или REJECT --reject-with tcp-reset.',
  host_unreachable: 'ICMP host unreachable — маршрут есть, но хост не отвечает.',
  net_unreachable: 'ICMP network unreachable — до сети нет маршрута вообще.',
  dns_fail:
    'Резолв не удаётся. Достоверность частичная: в зависимости от domainStrategy резолв мог произойти раньше, чем дело дошло до диалера.',
  tls_hang:
    'TCP соединяется, дальше никто не отвечает, и TLS-рукопожатие уходит в таймаут. Классическая картина «порт открыт, сервис мёртв» — и та, которую чаще всего принимают за рабочий сервер.',
  tls_garbage:
    'TCP соединяется, сервер отвечает шумом, и получается «first record does not look like a TLS handshake».',
  latency: 'Добавляет задержку к дозвону и к каждому чтению. Годится, чтобы заставить балансировщик переранжировать.',
  throttle: 'Ограничение скорости token bucket в обе стороны.',
  reset_after: 'Пропускает трафик, затем рвёт соединение через ECONNRESET.',
  udp_loss: 'Теряет заданную долю датаграмм. Осмысленно для QUIC, KCP и hysteria.',
}

/** Picks the catalogue for the active language. */
export function useCopy(): {
  rejectionLabel: Record<RejectionReason, string>
  rejectionHelp: Record<RejectionReason, string>
  stageLabel: Record<StageId, string>
  stageNote: Record<StageNote, NoteCopy>
  sourceCopy: Record<string, NoteCopy>
  faultLabel: Record<FaultKind, string>
  faultHelp: Record<FaultKind, string>
} {
  const { lang } = useT()
  return lang === 'ru'
    ? {
        rejectionLabel: rejectionLabelRu,
        rejectionHelp: rejectionHelpRu,
        stageLabel: stageLabelRu,
        stageNote: stageNoteRu,
        sourceCopy: sourceCopyRu,
        faultLabel: faultLabelRu,
        faultHelp: faultHelpRu,
      }
    : { rejectionLabel, rejectionHelp, stageLabel, stageNote, sourceCopy, faultLabel, faultHelp }
}
