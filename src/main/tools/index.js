import { runCommand } from './terminal.js'
import * as browser from './browser.js'
import * as files from './files.js'
import * as web from './web.js'
import * as jarvis from './jarvis.js'
import * as screen from './screen.js'
import { saveMemory, recallMemories } from '../memory/db.js'
import electron from 'electron'
const { clipboard, Notification } = electron || {}


// ---------------------------------------------------------------------------
// Tool Specifications for OpenAI / Gemini function calling
// ---------------------------------------------------------------------------
export const toolSpecs = [
  // ── Shell / Terminal ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: 'Run a bash command in the Crostini Linux container and return stdout, stderr, and exit code. Useful for compiling, running scripts, git, and system commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute.' },
          timeout_ms: { type: 'integer', description: 'Timeout in ms (default 30000).' }
        },
        required: ['command']
      }
    }
  },

  // ── Browser Automation (Playwright + Chrome OS Bridge Extension) ─────────
  {
    type: 'function',
    function: {
      name: 'browser_navigate',
      description: 'Navigate the browser to a given URL. Returns final URL and page title.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'The URL to visit.' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Extract visible text and structure from the active browser tab.',
      parameters: {
        type: 'object',
        properties: { offset: { type: 'integer', description: 'Offset for long pages.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the current page by visible button/link text or CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Visible text label of button/link to click (recommended).' },
          selector: { type: 'string', description: 'CSS selector of the element.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description: 'Fill in an input field, textarea, or select dropdown option.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Visible field label or placeholder.' },
          selector: { type: 'string', description: 'CSS selector of input.' },
          value: { type: 'string', description: 'Value to type into the field.' }
        },
        required: ['value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the browser page (viewport or full page).',
      parameters: {
        type: 'object',
        properties: { fullPage: { type: 'boolean', description: 'Capture full scrollable page.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the browser page up, down, top, or bottom.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Pixels to scroll (default 600)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description: 'Send keystrokes or shortcuts (e.g. Enter, Control+A, Control+V) or type text.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          keys: { type: 'string', description: 'Shortcut or special key name (e.g. Enter, Control+V)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: 'List all open browser tabs and windows.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_use_tab',
      description: 'Switch active control to a specific tab ID.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'number', description: 'Target tab ID' } },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_go_back',
      description: 'Go back in browser history.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_go_forward',
      description: 'Go forward in browser history.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_reload',
      description: 'Reload the current browser tab.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_tab',
      description: 'Close the current browser tab (opens about:blank if it would close the last tab).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_read_pages',
      description: 'Open and read multiple URLs in parallel (fast comparison/research).',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, description: 'List of URLs to fetch' },
          keepOpen: { type: 'boolean', description: 'Whether to keep tabs open' }
        },
        required: ['urls']
      }
    }
  },

  // ── Filesystem ───────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read contents of a local file with optional line offset/limit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file.' },
          offset: { type: 'integer', description: 'Start line number (1-indexed).' },
          limit: { type: 'integer', description: 'Maximum lines to return.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Write or overwrite a local file with new content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path.' },
          content: { type: 'string', description: 'Content to write.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_edit',
      description: 'Replace exact target text inside an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path.' },
          old_text: { type: 'string', description: 'Exact text to replace.' },
          new_text: { type: 'string', description: 'New replacement text.' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_search',
      description: 'Search for files by glob pattern within a directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Filename pattern, e.g. *.js or *config*' },
          directory: { type: 'string', description: 'Starting directory (default current dir)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_grep',
      description: 'Search for text pattern inside files (ripgrep/grep).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search term or regex.' },
          directory: { type: 'string', description: 'Directory to search in.' },
          path: { type: 'string', description: 'Specific file path.' }
        },
        required: ['pattern']
      }
    }
  },

  // ── Web Research ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo for fast information retrieval.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          num_results: { type: 'integer', description: 'Number of results to return (default 5).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract clean readable text from a public web page.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Web page URL.' } },
        required: ['url']
      }
    }
  },

  // ── Persistent Memory (Cross-Session) ────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'memory_save',
      description: 'Save a persistent fact, preference, or ongoing project detail across sessions.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Fact or note to remember.' },
          type: { type: 'string', enum: ['fact', 'preference', 'task', 'event'], description: 'Category' },
          importance: { type: 'integer', description: '1-10 priority level' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
          ttl_days: { type: 'number', description: 'Days before expiration (for temporary facts)' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_recall',
      description: 'Search persistent SQLite memory for facts, preferences, and project history.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term.' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'integer', description: 'Max items to recall' }
        }
      }
    }
  },

  // ── Jarvis Chromebook & System Tools ─────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'system_volume',
      description: 'Control Chromebook / Linux audio volume (get, set percentage, up, down, mute, unmute).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'up', 'down', 'mute', 'unmute', 'toggle_mute'], description: 'Action' },
          value: { type: 'number', description: 'Target percentage (0-100) or step amount' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_brightness',
      description: 'Get or set screen display brightness percentage.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'up', 'down'], description: 'Action' },
          value: { type: 'number', description: 'Brightness percentage (5-100)' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_power',
      description: 'Inspect Chromebook battery level/status, or lock/sleep the system.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['battery', 'lock', 'sleep'], description: 'Action to perform' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'system_telemetry',
      description: 'Check real-time hardware telemetry: CPU usage %, RAM %, disk space, battery status, and load averages.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'weather_get',
      description: 'Get live weather conditions and 3-day forecast for any city or current location.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name, zip code, or empty for local' },
          units: { type: 'string', enum: ['metric', 'imperial'], description: 'Units (Celsius/Fahrenheit)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_set',
      description: 'Set a scheduled reminder with a desktop notification and audio chime.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Reminder message to display.' },
          delay_seconds: { type: 'number', description: 'Seconds from now.' },
          at_time: { type: 'string', description: 'ISO or human time string.' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_list',
      description: 'List all currently active pending reminders.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'reminder_cancel',
      description: 'Cancel a scheduled reminder by ID.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Reminder ID to cancel' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'youtube_play',
      description: 'Search and open a YouTube video or search query in the browser.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Video title or topic search' },
          url: { type: 'string', description: 'Direct YouTube video URL' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'jarvis_action_run',
      description: 'Execute any Python action script or plugin from the Jarvis Mark-LIII collection.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action name (e.g. flight_finder, dev_agent, code_helper)' },
          args: { type: 'object', description: 'Arguments object to pass to the action' }
        },
        required: ['action']
      }
    }
  },

  // ── Desktop Integration ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'clipboard_read',
      description: 'Read the current text from the system clipboard.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'clipboard_write',
      description: 'Copy text to the system clipboard.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to copy.' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'notify_user',
      description: 'Display an OS desktop notification banner to the user.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          body: { type: 'string', description: 'Notification message text' }
        },
        required: ['body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screen_screenshot',
      description: 'Capture a full desktop screenshot (useful for observing Linux apps outside the browser).',
      parameters: { type: 'object', properties: {} }
    }
  }
]

// ---------------------------------------------------------------------------
// Tool Dispatcher & Execution Handler
// Returns { output: string, image?: string, isError?: boolean }
// ---------------------------------------------------------------------------
export async function executeTool(name, args = {}) {
  try {
    switch (name) {
      // Shell
      case 'terminal_run': {
        const res = await runCommand({ command: args.command, timeoutMs: args.timeout_ms })
        let text = ''
        if (res.stdout) text += res.stdout
        if (res.stderr) text += (text ? '\n--- stderr ---\n' : '') + res.stderr
        text += `\n[exit code: ${res.exitCode}]`
        return { output: text, isError: res.exitCode !== 0 }
      }

      // Browser
      case 'browser_navigate': {
        const r = await browser.browserNavigate({ url: args.url })
        return { output: `Navigated to ${r.url} — "${r.title}"` }
      }
      case 'browser_get_text': {
        const r = await browser.browserGetText({ offset: args.offset })
        const more = r.nextOffset != null ? `\n\n…(${r.totalChars - r.nextOffset} more chars available)` : ''
        return { output: `# ${r.title}\n${r.url}\n\n${r.text}${more}` }
      }
      case 'browser_click': {
        const r = await browser.browserClick({ selector: args.selector, text: args.text })
        return { output: `Clicked ${args.text ? `"${args.text}"` : args.selector} — now at ${r.url}` }
      }
      case 'browser_fill': {
        await browser.browserFill({ selector: args.selector, label: args.label, value: args.value })
        return { output: `Filled ${args.label ? `field "${args.label}"` : args.selector} with value.` }
      }
      case 'browser_screenshot': {
        const r = await browser.browserScreenshot({ fullPage: args.fullPage })
        return {
          output: `Screenshot captured (${args.fullPage ? 'full page' : 'viewport'})`,
          image: `data:image/png;base64,${r.base64}`
        }
      }
      case 'browser_scroll': {
        const r = await browser.browserScroll({ direction: args.direction, amount: args.amount })
        return { output: `Scrolled ${args.direction || 'down'} (${r.scrolledY}px)` }
      }
      case 'browser_press_key': {
        await browser.browserPressKey({ text: args.text, keys: args.keys })
        return { output: `Key event sent: ${args.text || args.keys}` }
      }
      case 'browser_list_tabs': {
        const r = await browser.browserListTabs()
        const tabs = r.tabs || []
        if (!tabs.length) return { output: 'No open tabs found.' }
        const text = tabs.map((t) => `- [tabId: ${t.tabId}] ${t.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n')
        return { output: text }
      }
      case 'browser_use_tab': {
        browser.setTargetTab(args.tabId)
        return { output: `Target tab set to ${args.tabId}` }
      }
      case 'browser_go_back': {
        const r = await browser.browserGoBack()
        return { output: `Went back — ${r.url}` }
      }
      case 'browser_go_forward': {
        const r = await browser.browserGoForward()
        return { output: `Went forward — ${r.url}` }
      }
      case 'browser_reload': {
        const r = await browser.browserReload()
        return { output: `Reloaded — ${r.url}` }
      }
      case 'browser_close_tab': {
        const r = await browser.browserCloseTab()
        return { output: `Closed tab — ${r.url || 'about:blank'}` }
      }
      case 'browser_read_pages': {
        const r = await browser.browserReadPages({ urls: args.urls, keepOpen: args.keepOpen })
        const text = (r.pages || [])
          .map((p, i) => `## [${i + 1}] ${p.title || p.url}\n${p.url}\n${(p.text || '').slice(0, 5000)}`)
          .join('\n\n---\n\n')
        return { output: text || 'No page content retrieved.' }
      }

      // Files
      case 'file_read': {
        const res = await files.fileRead(args)
        return { output: res.error || res.content, isError: !!res.error }
      }
      case 'file_write': {
        const res = await files.fileWrite(args)
        return { output: res.error || `Wrote ${res.bytes} bytes to ${res.path}`, isError: !!res.error }
      }
      case 'file_edit': {
        const res = await files.fileEdit(args)
        return { output: res.error || res.message, isError: !!res.error }
      }
      case 'file_search': {
        const res = await files.fileSearch(args)
        return { output: res.error || (res.files?.join('\n') || 'No files matched.'), isError: !!res.error }
      }
      case 'file_grep': {
        const res = await files.fileGrep(args)
        return { output: res.error || res.matches, isError: !!res.error }
      }

      // Web
      case 'web_search': {
        const res = await web.webSearch(args)
        if (res.error) return { output: res.error, isError: true }
        const formatted = (res.results || [])
          .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
          .join('\n\n')
        return { output: formatted || 'No search results.' }
      }
      case 'web_fetch': {
        const res = await web.webFetch(args)
        return { output: res.error || res.content, isError: !!res.error }
      }

      // Memory
      case 'memory_save': {
        const expiresAt = args.ttl_days ? Date.now() + args.ttl_days * 86_400_000 : null
        saveMemory({
          content: args.content,
          type: args.type || 'fact',
          importance: args.importance || 5,
          tags: args.tags || [],
          expiresAt
        })
        return { output: `Saved memory: "${args.content}"` }
      }
      case 'memory_recall': {
        const list = recallMemories({ query: args.query, tags: args.tags, limit: args.limit || 8 })
        if (!list.length) return { output: 'No matching memories found.' }
        const text = list.map((m) => `- [${m.type}] ${m.content}`).join('\n')
        return { output: text }
      }

      // Jarvis Tools
      case 'system_volume': {
        const res = await jarvis.systemVolume(args)
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }
      case 'system_brightness': {
        const res = await jarvis.systemBrightness(args)
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }
      case 'system_power': {
        const res = await jarvis.systemPower(args)
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }
      case 'system_telemetry': {
        const res = await jarvis.systemTelemetry()
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }
      case 'weather_get': {
        const res = await jarvis.weatherGet(args)
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }
      case 'reminder_set': {
        const res = jarvis.reminderSet(args)
        return { output: res.message || JSON.stringify(res) }
      }
      case 'reminder_list': {
        const res = jarvis.reminderList()
        return { output: JSON.stringify(res, null, 2) }
      }
      case 'reminder_cancel': {
        const res = jarvis.reminderCancel(args)
        return { output: res.message || res.error, isError: !!res.error }
      }
      case 'youtube_play': {
        const res = await jarvis.youtubePlay(args)
        return { output: res.message || res.error, isError: !!res.error }
      }
      case 'jarvis_action_run': {
        const res = await jarvis.jarvisActionRun(args)
        return { output: JSON.stringify(res, null, 2), isError: !!res.error }
      }

      // Desktop
      case 'clipboard_read': {
        const text = clipboard.readText()
        return { output: text ? `Clipboard content:\n${text}` : 'Clipboard is empty.' }
      }
      case 'clipboard_write': {
        clipboard.writeText(args.text || '')
        return { output: 'Text copied to clipboard.' }
      }
      case 'notify_user': {
        if (Notification.isSupported()) {
          new Notification({ title: args.title || 'Ghost-Prime', body: args.body }).show()
        }
        return { output: 'Notification displayed.' }
      }
      case 'screen_screenshot': {
        const r = await screen.screenScreenshot()
        return {
          output: 'Desktop screen captured.',
          image: `data:image/png;base64,${r.base64}`
        }
      }

      default:
        return { output: `Unknown tool "${name}".`, isError: true }
    }
  } catch (err) {
    return { output: `Tool execution failed: ${err.message}`, isError: true }
  }
}
