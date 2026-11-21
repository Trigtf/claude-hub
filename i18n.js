// Minimal i18n: English is the source language in the code, Greek lives in the EL map below.
// Plain script (no modules); loaded before renderer.js.
const EL = {
  // --- index.html ---
  'Runs: gcloud auth application-default login': 'Εκτελεί: gcloud auth application-default login',
  'Refresh list': 'Ανανέωση λίστας',
  'Search projects...': 'Αναζήτηση project...',
  'Pick a project on the left to open Claude Code': 'Διάλεξε ένα project από αριστερά για να ανοίξει το Claude Code',
  'Files for the project': 'Αρχεία για το project',
  'Automatically sends the path to the active terminal': 'Στέλνει αυτόματα τη διαδρομή στο ενεργό terminal',
  'automatic': 'αυτόματα',
  'Drop files/folders here or press Ctrl+V': 'Σύρε εδώ αρχεία/φακέλους ή πάτα Ctrl+V',
  'Paste clipboard': 'Επικόλληση clipboard',
  'Open the folder with pasted items': 'Άνοιγμα φακέλου με τα επικολλημένα',
  'Folder': 'Φάκελος',
  'Files from Claude': 'Αρχεία από το Claude',
  'Hides code and config files (js, py, css, json...)': 'Κρύβει αρχεία κώδικα και ρυθμίσεων (js, py, css, json...)',
  'deliverables only': 'μόνο παραδοτέα',
  'Clear list': 'Καθαρισμός λίστας',
  'New project': 'Νέο project',
  'Name': 'Όνομα',
  'e.g. my-new-app': 'π.χ. my-new-app',
  'Will be created in:': 'Θα δημιουργηθεί στο:',
  'change': 'αλλαγή',
  'Cancel': 'Άκυρο',
  'Create': 'Δημιουργία',
  'General': 'Γενικά',
  'Folder for new projects': 'Φάκελος για τα νέα projects',
  'Browse...': 'Επιλογή...',
  'Projects you create here are made in this folder and also show up in /project.': 'Τα projects που φτιάχνεις από εδώ δημιουργούνται σε αυτόν το φάκελο και εμφανίζονται και στο /project.',
  'Terminal font (name of an installed font)': 'Γραμματοσειρά terminal (όνομα εγκατεστημένου font)',
  'e.g. Cascadia Mono': 'π.χ. Cascadia Mono',
  'Font size (8-32)': 'Μέγεθος γραμμάτων (8-32)',
  'Default': 'Προεπιλογή',
  'Sample: Hello world, The quick brown fox 0123456789 {}[]()': 'Δείγμα: Καλημέρα κόσμε, The quick brown fox 0123456789 {}[]()',
  'Theme': 'Θέμα εμφάνισης',
  'Dark': 'Σκοτεινό',
  'Light': 'Φωτεινό',
  'Changes the hub and the terminal. Claude Code has its own color theme (/theme inside Claude) that you may want to match.': 'Αλλάζει το hub και το terminal. Το Claude Code έχει δικό του θέμα χρωμάτων (/theme μέσα στο Claude) που ίσως θες να το ταιριάξεις.',
  'Language': 'Γλώσσα',
  'Automatic': 'Αυτόματο',
  'Restart the app to apply': 'Κάνε επανεκκίνηση της εφαρμογής για να εφαρμοστεί',
  'Fast terminal rendering (WebGL)': 'Γρήγορη σχεδίαση terminal (WebGL)',
  'Uses the graphics card to draw terminal text. If you see visual glitches, turn it off.': 'Χρησιμοποιεί την κάρτα γραφικών για το κείμενο του terminal. Αν δεις γραφικά προβλήματα, απενεργοποίησέ το.',
  "Open with the project's last conversation": 'Άνοιγμα με την τελευταία συνομιλία του project',
  'When you open a project that has a previous conversation, it continues automatically (--continue). If you turn this off, a new conversation always starts.': 'Όταν ανοίγεις project που έχει προηγούμενη συνομιλία, συνεχίζεται αυτόματα (--continue). Αν το απενεργοποιήσεις, ξεκινά πάντα νέα συνομιλία.',
  'Edits': 'Αλλάζουν το',
  'Applies to new Claude sessions (tabs that are already open are not affected).': 'Ισχύουν για νέες συνεδρίες Claude (τα ήδη ανοιχτά tabs δεν επηρεάζονται).',
  'empty = Claude Code default': 'κενό = προεπιλογή του Claude Code',
  'bypassPermissions runs tools (commands, file writes) without asking. Use it only in projects you trust.': 'Το bypassPermissions εκτελεί εργαλεία (εντολές, εγγραφές αρχείων) χωρίς καμία ερώτηση. Χρησιμοποίησέ το μόνο σε projects που εμπιστεύεσαι.',
  'Allow bypass mode (otherwise permissions.disableBypassPermissionsMode is set)': 'Να επιτρέπεται το bypass mode (αλλιώς μπαίνει permissions.disableBypassPermissionsMode)',
  "Don't ask for confirmation when bypass is enabled (skipDangerousModePermissionPrompt)": 'Να μη ζητάει επιβεβαίωση όταν ενεργοποιείται το bypass (skipDangerousModePermissionPrompt)',
  'Allow (one rule per line)': 'Allow (ένας κανόνας ανά γραμμή)',
  'Automatic Claude Code updates': 'Αυτόματες ενημερώσεις του Claude Code',
  'Channel': 'Κανάλι',
  'The model (ANTHROPIC_MODEL) and DISABLE_AUTOUPDATER are set from the Claude tab.': 'Το model (ANTHROPIC_MODEL) και το DISABLE_AUTOUPDATER ρυθμίζονται από την καρτέλα Claude.',
  '+ Add variable': '+ Προσθήκη μεταβλητής',
  'gcloud env (for the Auth button, e.g. CLOUDSDK_CORE_PROJECT, GOOGLE_CLOUD_PROJECT)': 'gcloud env (για το κουμπί Auth, π.χ. CLOUDSDK_CORE_PROJECT, GOOGLE_CLOUD_PROJECT)',
  'Shows MCP servers for user, local and the active project. Additions and removals apply immediately (via': 'Εμφανίζονται οι MCP servers των user, local και του ενεργού project. Οι προσθήκες/διαγραφές γίνονται αμέσως (μέσω',
  'Check connection': 'Έλεγχος σύνδεσης',
  '+ Add server': '+ Προσθήκη server',
  'name': 'όνομα',
  'stdio (command)': 'stdio (εντολή)',
  'user (all projects)': 'user (όλα τα projects)',
  'local (active project)': 'local (ενεργό project)',
  'e.g. npx -y @modelcontextprotocol/server-filesystem C:/folder  or  https://example.com/mcp': 'π.χ. npx -y @modelcontextprotocol/server-filesystem C:/folder  ή  https://example.com/mcp',
  'env for stdio, separated by spaces: KEY=value KEY2=value2 (optional)': 'env για stdio, χωρισμένα με κενό: KEY=value KEY2=value2 (προαιρετικό)',
  'Add': 'Προσθήκη',
  'Save': 'Αποθήκευση',

  // --- renderer.js ---
  'now': 'τώρα',
  '{n}m ago': 'πριν {n}λ',
  '{n}h ago': 'πριν {n}ω',
  '{n}d ago': 'πριν {n}μ',
  'No results.': 'Κανένα αποτέλεσμα.',
  'Loading...': 'Φόρτωση...',
  'Unpin': 'Ξεκαρφίτσωμα',
  'Pin to top': 'Καρφίτσωμα στην κορυφή',
  'New files from Claude': 'Νέα αρχεία από το Claude',
  'Close': 'Κλείσιμο',
  'Font size: {n}': 'Μέγεθος γραμμάτων: {n}',
  'Failed to start: {error}': 'Αποτυχία εκκίνησης: {error}',
  '"{name}" is still running. Close it?': 'Το "{name}" τρέχει ακόμα. Να κλείσει;',
  'Login finished': 'Η σύνδεση ολοκληρώθηκε',
  'claude exited': 'Το claude έκλεισε',
  '[{what} (code {code}). Press Enter to restart.]': '[{what} (κωδικός {code}). Πάτα Enter για επανεκκίνηση.]',
  'Click to enlarge': 'Κλικ για μεγέθυνση',
  'Send again to the active terminal': 'Στείλε ξανά στο ενεργό terminal',
  'Remove from list': 'Αφαίρεση από τη λίστα',
  'Open a project first to send it': 'Άνοιξε πρώτα ένα project για να σταλεί',
  'Open a project first to add files': 'Άνοιξε πρώτα ένα project για να προστεθούν αρχεία',
  'The clipboard is empty': 'Το clipboard είναι άδειο',
  '{n} code files hidden (uncheck "deliverables only" to show them).': '{n} αρχεία κώδικα κρύβονται (ξετσέκαρε "μόνο παραδοτέα" για να τα δεις).',
  'When Claude creates a file in this project, it will appear here so you can save it.': 'Όταν το Claude δημιουργήσει αρχείο σε αυτό το project, θα εμφανιστεί εδώ για αποθήκευση.',
  'Pick a project to see its files.': 'Διάλεξε project για να δεις τα αρχεία του.',
  'Drag it to any folder or app': 'Σύρε το σε οποιοδήποτε φάκελο ή εφαρμογή',
  'Save as...': 'Αποθήκευση...',
  'Saved': 'Αποθηκεύτηκε',
  'Error': 'Σφάλμα',
  'Open': 'Άνοιγμα',
  'default (asks before each tool)': 'default (ρωτάει για κάθε εργαλείο)',
  'acceptEdits (auto-accepts file edits)': 'acceptEdits (δέχεται αυτόματα αλλαγές αρχείων)',
  'plan (planning only, no changes)': 'plan (μόνο σχεδιασμός, χωρίς αλλαγές)',
  'dontAsk (denies anything not pre-approved)': 'dontAsk (απορρίπτει ό,τι δεν είναι προεγκεκριμένο)',
  'auto (auto-approves with safety checks)': 'auto (αυτόματη έγκριση με ελέγχους ασφαλείας)',
  'bypassPermissions (never asks)': 'bypassPermissions (καμία ερώτηση)',
  'Saved to the ANTHROPIC_MODEL env (your settings.json already uses it, and it overrides the model key).': 'Αποθηκεύεται στο env ANTHROPIC_MODEL (το χρησιμοποιεί ήδη το settings.json σου και υπερισχύει του κλειδιού model).',
  'Saved to the model key in settings.json. If ANTHROPIC_MODEL is set in the environment, it takes precedence.': 'Αποθηκεύεται στο κλειδί model του settings.json. Αν οριστεί ANTHROPIC_MODEL στο περιβάλλον, αυτό υπερισχύει.',
  '{mode} (not supported by this Claude version)': '{mode} (δεν το δέχεται αυτή η έκδοση του Claude)',
  'No MCP servers.': 'Δεν υπάρχουν MCP servers.',
  'Delete': 'Διαγραφή',
  'Delete MCP server "{name}" ({scope})?': 'Διαγραφή του MCP server "{name}" ({scope});',
  'Checking connection...': 'Έλεγχος σύνδεσης...',
  'For local/project scope, open a project first.': 'Για local/project scope άνοιξε πρώτα ένα project.',
};

function lang() {
  let v = null;
  try { v = localStorage.getItem('hubLang'); } catch { /* storage unavailable */ }
  if (v === 'en' || v === 'el') return v;
  return String(navigator.language || '').toLowerCase().startsWith('el') ? 'el' : 'en';
}

function t(en, vars) {
  let out = lang() === 'el' && Object.prototype.hasOwnProperty.call(EL, en) ? EL[en] : en;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

function translateDom(root = document) {
  if (lang() !== 'el') return;
  const tr = (s) => (Object.prototype.hasOwnProperty.call(EL, s) ? EL[s] : null);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.nodeValue);
    if (!m[2]) continue;
    const hit = tr(m[2]);
    if (hit !== null) n.nodeValue = m[1] + hit + m[3];
  }
  const scope = root.querySelectorAll ? root : document;
  for (const el of scope.querySelectorAll('[title],[placeholder],[aria-label],[data-i18n]')) {
    for (const a of ['title', 'placeholder', 'aria-label']) {
      if (!el.hasAttribute(a)) continue;
      const hit = tr(el.getAttribute(a));
      if (hit !== null) el.setAttribute(a, hit);
    }
    if (el.dataset.i18n) {
      const hit = tr(el.dataset.i18n);
      if (hit !== null) el.textContent = hit;
    }
  }
  if (root === document) document.documentElement.lang = 'el';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => translateDom());
else translateDom();
