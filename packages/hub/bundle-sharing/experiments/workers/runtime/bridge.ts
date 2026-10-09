import { useSlideContext } from '@slidev/client/context.ts'

/** Match Slidev's generated slide setup wrapper around useSlideContext. */
export function slideSetup() {
  const context = useSlideContext()
  context.$clicksContext.setup()
  return context
}

export { useSlideContext }
