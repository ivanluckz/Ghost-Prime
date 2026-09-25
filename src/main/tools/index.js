import { runCommand } from './terminal.js'
import * as browser from './browser.js'
import * as files from './files.js'
import * as web from './web.js'
import * as jarvis from './jarvis.js'
import * as screen from './screen.js'
import * as phone from './phone.js'
import { pairingInfo } from './pairing.js'
import * as fileUndo from './file-undo.js'
import * as reminders from './reminders.js'
import { saveMemory, recallMemories } from '../memory/db.js'
import { envBool } from '../env.js'
import electron from 'electron'
const { clipboard, Notification } = electron || {}


// ---------------------------------------------------------------------------
// Tool Specifications for OpenAI / Gemini function calling
// ---------------------------------------------------------------------------
const ALL_TOOL_SPECS = [
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
      description: 'Open a URL in the browser (a bare domain like "example.com" is fine). Returns the final URL and page title.',
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
      name: 'browser_get_page',
      description:
        'Structured snapshot of the current page: every visible button, link, input field and dropdown, each numbered [N], plus a short excerpt. ' +
        'Call this BEFORE acting, then use browser_click / browser_fill with { ref: N } — the most reliable way to hit the right element. ' +
        'Refs work on both backends (Playwright and the Chrome extension); if a result says a ref is unknown or stale, call this again or fall back to { text } / browser_click_at { x, y }.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: 'Max items per category (default 40, max 60).' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_get_text',
      description: 'Extract visible text from the current page and its iframes (for reading long content; prefer browser_get_page for acting). Returns up to 20k chars; pass the returned nextOffset to continue.',
      parameters: {
        type: 'object',
        properties: { offset: { type: 'integer', description: 'Offset for long pages.' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_find',
      description:
        'Find a phrase on the current page (like Ctrl+F): returns the hit count and a snippet around each match, and scrolls the first one into view. ' +
        'Fully supported on the Playwright backend; on the Chrome-extension backend use browser_get_text if it is unavailable.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Phrase to look for (case-insensitive).' },
          limit: { type: 'integer', description: 'Max snippets to return (default 5).' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element. BEST: { ref: N } using a number from browser_get_page or an annotated screenshot. Or { text } for its visible label, or { selector } (standard CSS only — never jQuery :contains/:eq). ' +
        'The result says whether the page changed and reports any dialog, download or new tab; a new page means refs are stale — call browser_get_page again.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Element number from browser_get_page / annotated screenshot (preferred).' },
          text: { type: 'string', description: 'Visible text label of the button/link to click.' },
          selector: { type: 'string', description: 'CSS or xpath= selector.' },
          double: { type: 'boolean', description: 'Double-click.' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click_at',
      description:
        'Click a point you located in a screenshot — x and y are fractions of the image (0..1, top-left origin). Use when no ref/text/selector reaches the element (canvas, maps, icon-only controls).',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Horizontal position, 0..1 of the viewport width.' },
          y: { type: 'number', description: 'Vertical position, 0..1 of the viewport height.' }
        },
        required: ['x', 'y']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_hover',
      description:
        'Hover an element (by ref, visible text, or CSS selector) to open hover menus / reveal row actions / show tooltips before clicking what appears. ' +
        'Refs are fully supported on the Playwright backend; on the Chrome-extension backend fall back to { text } if a ref is unknown.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Element number from browser_get_page.' },
          text: { type: 'string', description: 'Visible text of the element.' },
          selector: { type: 'string', description: 'CSS selector.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_fill',
      description:
        'Type a value into an input/textarea/editor, pick a dropdown option (by its visible text), or set a checkbox/radio (value "true"/"false"). ' +
        'Target it with { ref: N } from browser_get_page (preferred), { label } (visible label/placeholder), or { selector } (CSS). Add pressEnter:true to submit right after (search boxes, login forms).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: 'Field number from browser_get_page (preferred).' },
          label: { type: 'string', description: 'Visible field label or placeholder.' },
          selector: { type: 'string', description: 'CSS selector of the input.' },
          value: { type: 'string', description: 'Value to type / option text to choose / "true" or "false" for checkboxes.' },
          pressEnter: { type: 'boolean', description: 'Press Enter after filling (submit).' }
        },
        required: ['value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the browser page so you can SEE it. Pass annotate:true to draw each clickable element\'s number [N] on the image — then click by { ref: N }. ' +
        'Pass fullPage:true for the whole scrollable page (not combinable with annotate). ' +
        'Annotate works on both backends (Playwright and the Chrome extension); if a result says a ref is unknown or stale, re-take it or fall back to { text } / browser_click_at { x, y }.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page.' },
          annotate: { type: 'boolean', description: 'Number every clickable element on the image (Set-of-Mark).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page (or a specific scrollable element) up, down, top, or bottom to reveal more content / trigger infinite scroll. Then look again with browser_get_page or browser_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Pixels to scroll (default ~one screen)' },
          selector: { type: 'string', description: 'CSS selector of a scrollable panel to scroll instead of the page.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_press_key',
      description:
        'Send real keystrokes to whatever has focus — the way to type into editors with no form field (Google Docs, Notion, code editors): click into it first, then call this. ' +
        '{ text } types literally; { keys } presses one combo ("Enter", "Control+A", "Tab", "ArrowDown", "Escape"); { sequence } presses several in order.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          keys: { type: 'string', description: 'One key or combo, e.g. Enter, Control+V, Shift+Tab' },
          sequence: { type: 'array', items: { type: 'string' }, description: 'Several keys/combos to press in order.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_tabs',
      description: 'List all open browser tabs with their tabId, URL, title and which one is active.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_use_tab',
      description: 'Switch which tab your browser actions act on (tabId from browser_list_tabs).',
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
      name: 'browser_wait_for',
      description: 'Wait until a CSS selector or visible text appears on the page (any frame) — for SPAs, spinners, search results, post-login redirects. Errors with a clear message on timeout.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          text: { type: 'string', description: 'Visible text to wait for' },
          timeoutMs: { type: 'integer', description: 'Max wait time in ms (default 10000, max 30000)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait_for_navigation',
      description: 'Wait for a slow page load / redirect chain to finish. Clicks already wait for the navigation they trigger, so you rarely need this.',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'integer', description: 'Max wait time in ms (default 30000, max 60000)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close_tab',
      description: 'Close the current browser tab (returns to the tab that opened it, or opens about:blank if it was the last).',
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

  // ── Android phone (connector app over the bridge) ────────────────────────
  {
    type: 'function',
    function: {
      name: 'phone_pair',
      description:
        "Show a QR code that pairs the user's Android phone (the Ghost-Prime connector app) with this computer — they scan it with the phone camera and it connects. Use when they ask to connect/pair/set up their phone, or when a phone_* tool says no phone is connected.",
      parameters: {
        type: 'object',
        properties: { host: { type: 'string', description: "The Chromebook's Wi-Fi IP, only if the user just told you a new one." } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_screenshot',
      description: "See the connected Android phone's screen (real pixels). Afterwards phone_tap / phone_swipe accept 0..1 fractions of this image.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_ui',
      description: "List the phone's on-screen elements from the accessibility tree — numbered, with text, role and the pixel point to tap. The phone equivalent of browser_get_page; use it before tapping.",
      parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Max elements (default 60).' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_tap',
      description: 'Tap on the phone: { text } for a visible label (preferred), or { x, y } as pixels from phone_ui or 0..1 fractions of the last phone_screenshot.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Visible text/label of the element to tap.' },
          x: { type: 'number', description: 'Horizontal position (pixels, or 0..1 of the screenshot).' },
          y: { type: 'number', description: 'Vertical position (pixels, or 0..1 of the screenshot).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_swipe',
      description: 'Swipe/scroll on the phone. { direction: "up" } scrolls the content up (i.e. reads further down), "down", "left", "right"; or { from:{x,y}, to:{x,y} }.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Finger direction.' },
          from: { type: 'object', description: 'Start point {x,y}.' },
          to: { type: 'object', description: 'End point {x,y}.' },
          durationMs: { type: 'integer', description: 'Gesture duration (default 300).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_type',
      description: 'Type text into the focused field on the phone (tap the field first).',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to type.' } }, required: ['text'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_key',
      description: "Press a phone navigation key: back, home or recents.",
      parameters: { type: 'object', properties: { key: { type: 'string', enum: ['back', 'home', 'recents'] } }, required: ['key'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'phone_open_app',
      description: 'Open an app on the phone by package name ({ app: "com.whatsapp" }) or open a URL / deep link ({ url }).',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Android package name, e.g. com.instagram.android' },
          url: { type: 'string', description: 'A URL or deep link to open.' }
        }
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
      description: 'Write or overwrite a local file, REVERSIBLY — the previous version is snapshotted so undo_last restores it. Use file_edit for surgical in-place edits.',
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
          directory: { type: 'string', description: "Starting directory (relative paths resolve against the user's home directory; default: home)" }
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
          directory: { type: 'string', description: "Directory to search in (relative paths resolve against the user's home directory)." },
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
          query: { type: 'string', description: 'Search term (omit for the most important memories).' },
          tag: { type: 'string', description: 'Restrict to memories carrying this tag.' },
          limit: { type: 'integer', description: 'Max items to recall (default 8)' }
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
          value: { type: 'number', description: 'For set: the level to set, 0-100 ("turn it to 80" = set 80). For up/down: how much to change it by (default 5). Never goes above 100.' }
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
      description: 'Set a scheduled reminder with a desktop notification and audio chime. Give EITHER delay_seconds OR at_time (ISO 8601) — resolve vague times ("at 5", "in half an hour") yourself first.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Reminder message to display.' },
          delay_seconds: { type: 'number', description: 'Seconds from now.' },
          at_time: { type: 'string', description: 'ISO 8601 date-time (compute it yourself; e.g. 2026-09-19T17:00:00).' }
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
  },
  {
    type: 'function',
    function: {
      name: 'file_move',
      description: 'Move or rename a file, REVERSIBLY (undo_last puts it back). Prefer this over shell mv for anything the user might undo.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string', description: 'Source path.' }, to: { type: 'string', description: 'Destination path.' } },
        required: ['from', 'to']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_delete',
      description: 'Delete a file, REVERSIBLY — it is snapshotted first so undo_last restores it. Files only.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File to delete.' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_create',
      description: 'Create a NEW file reversibly (errors if it exists; use file_write to overwrite). undo_last removes it.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'New file path.' }, content: { type: 'string', description: 'Initial content.' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undo_last',
      description: 'Take back the most recent reversible file change (move/delete/create/reversible-write). Use when the user says "undo that", "revert", "put it back".',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'undo_list',
      description: 'Show the stack of file changes that can still be undone (newest first).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_drag',
      description:
        'Drag-and-drop on the page. Element mode: { fromSelector, toSelector } (CSS). Point mode: ' +
        '{ from:{x,y}, to:{x,y} } as viewport fractions 0..1 (locate the handle in a screenshot, then drag). ' +
        'Use for sliders, reordering lists, Kanban cards, drag-to-upload zones. Fully supported on the Playwright backend; on the Chrome-extension backend use point mode from a screenshot.',
      parameters: {
        type: 'object',
        properties: {
          fromSelector: { type: 'string', description: 'CSS selector of the element to drag.' },
          toSelector: { type: 'string', description: 'CSS selector of the drop target.' },
          from: { type: 'object', description: 'Start point {x,y} (0..1 fractions or pixels).' },
          to: { type: 'object', description: 'End point {x,y} (0..1 fractions or pixels).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_list_browsers',
      description: 'List the connected browsers/devices Ghost can drive (separate Chrome windows/profiles, or a phone) and which one is selected.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_use_browser',
      description: 'Choose which connected browser/device to drive, by id (from browser_list_browsers).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Browser id from browser_list_browsers.' } },
        required: ['id']
      }
    }
  }
]

// screen_screenshot is experimental (see src/main/tools/screen.js) and gated behind
// GHOST_SCREEN_TOOLS=1 on the Claude path — apply the same gate here. Read at call time so a
// late dotenv load still counts.
export function getToolSpecs() {
  return envBool('GHOST_SCREEN_TOOLS', false) ? ALL_TOOL_SPECS : ALL_TOOL_SPECS.filter((t) => t.function.name !== 'screen_screenshot')
}
// Load-time snapshot for scripts that import the list directly (they load dotenv first).
export const toolSpecs = getToolSpecs()

// ---------------------------------------------------------------------------
// Tool Dispatcher & Execution Handler
// Returns { output: string, image?: string, isError?: boolean }
// ---------------------------------------------------------------------------
// `signal` (optional) is the chat's AbortController — threaded into long tool calls so Stop
// actually interrupts them. Existing 2-arg callers keep working.
export async function executeTool(name, args = {}, { signal } = {}) {
  try {
    switch (name) {
      // Shell
      case 'terminal_run': {
        // Normalise once: a JSON null/0/"abc" from the model must fall back to the default, not
        // pass through as setTimeout(fn, null) and kill the command on the next tick.
        const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : 30000
        const res = await runCommand({ command: args.command, timeoutMs, signal })
        let text = ''
        if (res.stdout) text += res.stdout
        if (res.stderr) text += (text ? '\n--- stderr ---\n' : '') + res.stderr
        // code is null when the shell died from a signal (timeout / abort)
        const codeLabel = res.code == null ? 'killed by signal' : String(res.code)
        text += `\n[exit code: ${codeLabel}${res.timedOut ? ` (timed out after ${timeoutMs} ms — process tree killed)` : ''}]`
        return { output: text, isError: res.timedOut || res.code !== 0 }
      }

      // Browser
      case 'browser_navigate': {
        const r = await browser.browserNavigate({ url: args.url })
        return { output: browser.formatActionResult(r.partial ? 'Opened (still loading when the timeout hit)' : 'Navigated', { ...r, navigated: false }) }
      }
      case 'browser_get_page': {
        const r = await browser.browserGetPage({ limit: args.limit })
        return { output: r.formatted || browser.formatPageSnapshot(r) }
      }
      case 'browser_get_text': {
        const r = await browser.browserGetText({ offset: args.offset })
        const more = r.nextOffset != null ? `\n\n…(${r.totalChars - r.nextOffset} more chars — call again with offset: ${r.nextOffset})` : ''
        return { output: `# ${r.title}\n${r.url}\n\n${r.text}${more}` }
      }
      case 'browser_find': {
        const r = await browser.browserFind({ text: args.text, limit: args.limit })
        if (!r.count) return { output: `"${args.text}" was not found on the page.` }
        return {
          output:
            `${r.count} match${r.count === 1 ? '' : 'es'} for "${args.text}"${r.scrolled ? ' (scrolled the first one into view)' : ''}:\n` +
            r.matches.map((m, i) => `${i + 1}. ${m}`).join('\n')
        }
      }
      case 'browser_click': {
        const r = await browser.browserClick({
          ref: args.ref,
          selector: args.selector,
          text: args.text,
          double: args.double,
          button: args.button
        })
        const what = args.ref != null ? `[${args.ref}]` : args.text ? `"${args.text}"` : args.selector
        return { output: browser.formatActionResult(`Clicked ${what}`, r) }
      }
      case 'browser_click_at': {
        const r = await browser.browserClickAt({ x: args.x, y: args.y })
        return { output: browser.formatActionResult(`Clicked at (${args.x}, ${args.y})`, r) }
      }
      case 'browser_hover': {
        const r = await browser.browserHover({ ref: args.ref, selector: args.selector, text: args.text })
        const what = args.ref != null ? `[${args.ref}]` : args.text ? `"${args.text}"` : args.selector
        return { output: browser.formatActionResult(`Hovering ${what}`, r) }
      }
      case 'browser_drag': {
        const r = await browser.browserDrag(args)
        return { output: browser.formatActionResult(`Dragged (${r.mode})`, r) }
      }
      case 'browser_fill': {
        const r = await browser.browserFill({
          ref: args.ref,
          selector: args.selector,
          label: args.label,
          value: args.value,
          pressEnter: args.pressEnter
        })
        const what = args.ref != null ? `[${args.ref}]` : args.label ? `field "${args.label}"` : args.selector
        return { output: browser.formatActionResult(`Filled ${what}${args.pressEnter ? ' and pressed Enter' : ''}`, r) }
      }
      case 'browser_screenshot': {
        const r = await browser.browserScreenshot({ fullPage: args.fullPage, annotate: args.annotate })
        const legend = r.marks ? `\nNumbered elements: ${browser.formatMarks(r.marks)}` : ''
        const note = typeof r.note === 'string' && r.note ? `\n${r.note}` : '' // e.g. "annotate unsupported on this backend"
        return {
          output: `Screenshot captured (${r.marks ? `annotated — ${r.marks.length} elements numbered` : args.fullPage ? 'full page' : 'viewport'})${legend}${note}`,
          image: `data:image/png;base64,${r.base64}`
        }
      }
      case 'browser_scroll': {
        const r = await browser.browserScroll({ direction: args.direction, amount: args.amount, selector: args.selector })
        return { output: `Scrolled ${args.direction || 'down'} (now at ${r.scrollY}px)` }
      }
      case 'browser_press_key': {
        const keys = Array.isArray(args.sequence) && args.sequence.length ? args.sequence : args.keys
        const r = await browser.browserPressKey({ text: args.text, keys })
        const did = [args.text ? 'Typed text' : null, keys ? `pressed ${Array.isArray(keys) ? keys.join(', ') : keys}` : null].filter(Boolean).join('; ')
        return { output: browser.formatActionResult(did || 'Sent keystrokes', r) }
      }
      case 'browser_list_tabs': {
        const r = await browser.browserListTabs()
        const tabs = r.tabs || []
        if (!tabs.length) return { output: 'No open tabs found.' }
        const text = tabs.map((t) => `- [tabId: ${t.tabId}] ${t.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n')
        return { output: text }
      }
      case 'browser_use_tab': {
        const r = await browser.useTab(args.tabId)
        return { output: r.pinned ? browser.formatActionResult(`Acting on tab ${r.tabId}`, r) : 'Unpinned — using the default tab.' }
      }
      case 'browser_go_back': {
        const r = await browser.browserGoBack()
        return { output: browser.formatActionResult('Went back', { ...r, navigated: false }) }
      }
      case 'browser_go_forward': {
        const r = await browser.browserGoForward()
        return { output: browser.formatActionResult('Went forward', { ...r, navigated: false }) }
      }
      case 'browser_reload': {
        const r = await browser.browserReload()
        return { output: browser.formatActionResult('Reloaded', { ...r, navigated: false }) }
      }
      case 'browser_wait_for': {
        const r = await browser.browserWaitFor({ selector: args.selector, text: args.text, timeoutMs: args.timeoutMs })
        return { output: `Found ${args.selector ? `selector ${args.selector}` : `text "${args.text}"`} — at ${r.url}` }
      }
      case 'browser_wait_for_navigation': {
        const r = await browser.browserWaitForNavigation({ timeoutMs: args.timeoutMs })
        // navigated: true/false from either backend; an older extension build omits it — then the wait
        // ended on a load, so say that rather than "nothing happened". A real navigation stales refs.
        const lead = r.navigated ? 'Navigation complete' : r.navigated === false ? 'No navigation happened' : 'Page finished loading'
        return { output: browser.formatActionResult(lead, { ...r, navigated: !!r.navigated }) }
      }
      case 'browser_close_tab': {
        const r = await browser.browserCloseTab()
        return { output: browser.formatActionResult('Closed tab', r) }
      }
      case 'browser_read_pages': {
        const r = await browser.browserReadPages({ urls: args.urls, keepOpen: args.keepOpen })
        const text = (r.pages || [])
          .map((p, i) => `## [${i + 1}] ${p.title || p.url}\n${p.url}\n${p.error ? `(could not read: ${p.error})` : (p.text || '').slice(0, 5000)}`)
          .join('\n\n---\n\n')
        return { output: text || 'No page content retrieved.' }
      }
      case 'browser_list_browsers': {
        const list = browser.listBrowsers() || []
        if (!list.length) return { output: 'No browsers connected.' }
        return {
          output: list
            .map((d) => `- ${d.id} "${d.name}"${d.selected ? ' (selected)' : ''}${d.connected ? '' : ' [offline]'}`)
            .join('\n')
        }
      }
      case 'browser_use_browser': {
        const ok = browser.useBrowser(args.id)
        return { output: ok ? `Now driving ${args.id}.` : `No connected browser with id ${args.id}.` }
      }

      // Phone
      case 'phone_pair': {
        const r = await pairingInfo({ host: args.host })
        if (!r.dataUrl) return { output: `Can't make the pairing QR yet: ${r.problems.join(' ')}`, isError: true }
        const notes = r.problems.length ? `\nHeads-up: ${r.problems.join(' ')}` : ''
        return {
          output: `Pairing QR ready (${r.host}:${r.port}). Tell the user: open the phone camera, point it at the code, tap the link — the connector app opens and connects. Port forwarding for ${r.port} must be on in Chrome OS Linux settings.${notes}`,
          image: r.dataUrl
        }
      }
      case 'phone_screenshot': {
        const r = await phone.phoneScreenshot()
        return { output: `Phone screenshot captured (${r.w}×${r.h})`, image: `data:image/png;base64,${r.base64}` }
      }
      case 'phone_ui': {
        const r = await phone.phoneUi({ limit: args.limit })
        return { output: r.formatted }
      }
      case 'phone_tap': {
        const r = await phone.phoneTap({ text: args.text, x: args.x, y: args.y })
        const what = args.text ? `"${args.text}"` : `(${args.x}, ${args.y})`
        return { output: r?.ok === false ? `Couldn't tap ${what} — nothing matched. Call phone_ui or phone_screenshot and try again.` : `Tapped ${what}`, isError: r?.ok === false }
      }
      case 'phone_swipe': {
        const r = await phone.phoneSwipe({ direction: args.direction, from: args.from, to: args.to, durationMs: args.durationMs })
        return { output: r?.ok === false ? 'Swipe was not performed.' : `Swiped ${args.direction || 'between points'}`, isError: r?.ok === false }
      }
      case 'phone_type': {
        const r = await phone.phoneType({ text: args.text })
        return { output: r?.ok === false ? 'Nothing is focused to type into — tap a field first.' : 'Typed text', isError: r?.ok === false }
      }
      case 'phone_key': {
        await phone.phoneKey({ key: args.key })
        return { output: `Pressed ${args.key}` }
      }
      case 'phone_open_app': {
        const r = await phone.phoneOpenApp({ app: args.app, url: args.url })
        return { output: `Opened ${r?.url || r?.app || args.app || args.url}` }
      }

      // Files
      case 'file_read': {
        const res = await files.fileRead(args)
        return { output: res.error || res.content, isError: !!res.error }
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

      // Reversible file ops + undo (src/main/tools/file-undo.js) — clear errors bubble to the outer catch.
      case 'file_write':
        return { output: await fileUndo.writeFile(args.path, args.content ?? '') }
      case 'file_move':
        return { output: await fileUndo.moveFile(args.from, args.to) }
      case 'file_delete':
        return { output: await fileUndo.deleteFile(args.path) }
      case 'file_create':
        return { output: await fileUndo.createFile(args.path, args.content || '') }
      case 'undo_last':
        return { output: await fileUndo.undoLast() }
      case 'undo_list':
        return { output: fileUndo.undoList() }

      // Web
      case 'web_search': {
        const res = await web.webSearch({ ...args, signal })
        if (res.error) return { output: res.error, isError: true }
        const formatted = (res.results || [])
          .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
          .join('\n\n')
        return { output: formatted || 'No search results.' }
      }
      case 'web_fetch': {
        const res = await web.webFetch({ ...args, signal })
        return { output: res.error || res.content, isError: !!res.error }
      }

      // Memory
      // db.js takes positional args: saveMemory(content, type, importance, opts) / recallMemories(query, limit, opts).
      case 'memory_save': {
        const expiresAt = args.ttl_days ? Date.now() + args.ttl_days * 86_400_000 : null
        const id = saveMemory(args.content, args.type || 'fact', args.importance || 5, { tags: args.tags || [], expiresAt })
        if (!id) return { output: 'Could not save memory (empty content or memory store unavailable).', isError: true }
        return { output: `Saved memory: "${args.content}"` }
      }
      case 'memory_recall': {
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 8))
        // db.js filters on a single tag; accept a legacy `tags` array too (first entry).
        const tag = args.tag || (Array.isArray(args.tags) ? args.tags[0] : args.tags)
        const list = recallMemories(args.query || '', limit, { tag })
        if (!list.length) return { output: 'No matching memories found.' }
        const text = list.map((m) => `- [${m.type}${m.tags?.length ? ' · ' + m.tags.join(',') : ''}] ${m.content}`).join('\n')
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
      // Reminders — DB-backed + fired by the shared scheduler (survive restart; spoken if voice is on).
      case 'reminder_set': {
        try {
          const { dueAt } = reminders.setReminder({ text: args.text, at: args.at_time, inSeconds: args.delay_seconds })
          return { output: `Reminder set for ${new Date(dueAt).toLocaleString()}: "${args.text}"` }
        } catch (e) {
          // reminders.js names its own arg names; translate to the ones in this tool's schema
          const msg = String(e.message || e).replace(/`at` \(ISO 8601\) or `inMinutes` \/ `inSeconds`/, '`at_time` (ISO 8601) or `delay_seconds`')
          return { output: `Could not set reminder: ${msg}`, isError: true }
        }
      }
      case 'reminder_list': {
        const list = reminders.listReminders()
        return {
          output: list.length
            ? list.map((r) => `- ${new Date(r.dueAt).toLocaleString()} — ${r.text}  (id: ${r.id})`).join('\n')
            : 'No pending reminders.'
        }
      }
      case 'reminder_cancel': {
        const ok = reminders.cancelReminderById(args.id)
        return { output: ok ? 'Reminder cancelled.' : 'No such reminder.', isError: !ok }
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
