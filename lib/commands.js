/**
 * Human-facing slash commands.
 *
 * `/bw` reports the browser state and `/bw-setup` opens the inspect page, so a
 * user can drive the whole authorization flow without knowing the URL. A command
 * handler runs against the receiving agent without involving the model, and its
 * result is text shown to the user.
 */
const LOG_PREFIX = 'dsh-browsercontrol-mcp:'

/**
 * @param {any} ctx plugin context
 * @param {ReturnType<import('./guide.js').createGuide>} guide
 * @param {Record<string, any>} config normalized plugin config
 */
export function registerCommands(ctx, guide, config, log = console) {
  if (typeof ctx?.inject !== 'function') return
  try {
    ctx.inject(['commands'], (inner) => {
      inner.effect(() => {
        const disposers = [
          inner.commands.register({
            definitionId: 'dsh-browsercontrol-mcp:browser-status',
            name: 'bw',
            description: '浏览器自动化状态：模式、目标浏览器、远程调试是否就绪',
            handler: async () => {
              await guide.refreshNow()
              return { kind: 'success', text: guide.statusText() }
            },
          }),
          inner.commands.register({
            definitionId: 'dsh-browsercontrol-mcp:browser-setup',
            name: 'bw-setup',
            description: '打开浏览器远程调试设置页，引导完成授权',
            handler: async () => {
              await guide.refreshNow()
              if (config.mode !== 'cdp') return { kind: 'error', text: `当前 mode=${config.mode}，不需要远程调试授权。` }
              if (guide.state.state === 'ready') return { kind: 'success', text: '远程调试已就绪，无需再设置。' }
              const result = await guide.openNow()
              return { kind: result.ok ? 'success' : 'error', text: result.text }
            },
          }),
        ]
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.()
            } catch {
              // A failed unregister must not break disposal of the rest.
            }
          }
        }
      }, 'browsercontrol-mcp.commands')
    })
  } catch (error) {
    log.error?.(`${LOG_PREFIX} command registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
