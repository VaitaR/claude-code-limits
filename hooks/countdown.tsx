// A countdown ticking on the surface's frame clock, so the cache TTL and reset times move between redraws.
import type { ClientModule } from 'claude-code'
import { fmtCacheLeft, fmtLeft } from './core'

type Props = { until: number; now: number; kind: 'cache' | 'left'; color: string; warn: string; hot: string }
type Ref = { left: number; lastNow: number }
type State = { ref: Ref }

const text = (props: Props, left: number) => (props.kind === 'left' ? fmtLeft(left) : left <= 0 ? '○ cold' : `● ${fmtCacheLeft(left)}`)

const Countdown: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { left: 0, lastNow: -1 }
  if (props.now !== ref.lastNow) {
    ref.lastNow = props.now
    ref.left = props.until - props.now
  }
  if (surface.state === undefined) {
    surface.setState({ ref })
    // A tick a minute would drift, so it ticks each second but repaints only when the shown text
    // changes: each minute, then each second of the cache's last one.
    surface.every(1000, () => {
      if (ref.left <= 0) return
      const was = text(props, ref.left)
      ref.left -= 1000
      if (text(props, ref.left) !== was) surface.setState({ ref })
    })
  }
  if (props.kind === 'left') return <Text color={props.color}>{fmtLeft(ref.left)}</Text>
  // Amber with time left to send one more prompt.
  const color = ref.left <= 0 ? props.hot : ref.left < 5 * 60_000 ? props.warn : props.color
  return <Text color={color}>{text(props, ref.left)}</Text>
}

export default Countdown
