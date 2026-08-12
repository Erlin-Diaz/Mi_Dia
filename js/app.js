// ============================================================================
// "Tu día" — lógica de la app (DOM, almacenamiento, sincronización).
// La lógica pura (sin DOM ni red) vive en ./logic.mjs y tiene tests en
// ../tests/logic.test.mjs — corré `npm test` para verificarla.
// ============================================================================
import {
    escapeHtml, parseTimeToMinutes, byTimeThenOrder, isOverdue,
    formatDateKey, findPreviousDayKey, applyCarryOver, splitTasksForRender,
    splitSomedayForRender, computeDialPct, isDayComplete, taskHtml, taskEditHtml,
    isSchoolTaskOverdue, groupSchoolTasksByChild, schoolTaskHtml, schoolTaskEditHtml,
} from "./logic.mjs";

// ======================================================================
// 1) CONFIGURA AQUÍ TU PROYECTO FIREBASE
//    Copia este objeto desde: Firebase Console → ⚙ Configuración del
//    proyecto → General → "Tus apps" → app web → SDK setup and config.
//    Es seguro que estos valores queden visibles en el HTML: no son
//    secretos, son solo el identificador público de tu proyecto.
// ======================================================================
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCu9i8OraG5fEcygjFS_v1vMC-cR-eM6G8",
    authDomain: "mi-dia-64c4a.firebaseapp.com",
    projectId: "mi-dia-64c4a",
    storageBucket: "mi-dia-64c4a.firebasestorage.app",
    messagingSenderId: "1011037762631",
    appId: "1:1011037762631:web:1aef38169cae87dfc46d62"
};
// ======================================================================
// Los SDK de Firebase se cargan con import() dinámico (más abajo, dentro
// de initFirebaseSync) en vez de con un "import" estático acá arriba. Si
// se cargaran acá y el CDN no respondiera (sin conexión, red que lo
// bloquea, CDN caído), TODO este módulo fallaría al cargar — y con eso,
// toda la app dejaría de funcionar, no solo la sincronización. Con
// import() dinámico, un fallo ahí se puede atajar con try/catch y la app
// sigue funcionando en modo solo local.
var setDocFn = null; // se completa cuando (si) Firebase termina de cargar

// Limpieza de claves de versiones anteriores del traslado automático de
// tareas (dejaron de usarse en favor de "planner-carriedDate-v3").
["planner-lastDate", "planner-carriedDate", "planner-carriedDate-v2"].forEach(function (k) {
    try { localStorage.removeItem(k); } catch (e) { }
});

var now = new Date();
var dateKey = formatDateKey(now);
var localStorageKey = "planner-" + dateKey;
var SOMEDAY_KEY = "planner-someday"; // no lleva fecha: no se resetea cada día
var SCHOOL_KEY = "planner-school"; // ídem, para "Tareas del cole"

var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var hour = now.getHours();
document.getElementById("greeting").textContent = hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
document.getElementById("dateHeading").textContent = now.toLocaleDateString("es-ES", { day: "numeric", month: "long" });
document.getElementById("dayName").textContent = now.toLocaleDateString("es-ES", { weekday: "long" });

var state = { tasks: [] };
try {
    var saved = localStorage.getItem(localStorageKey);
    if (saved) state = JSON.parse(saved);
} catch (e) { }

// Lista "Algún día": tareas sin día asociado (no se resetean, no vencen).
var somedayState = { tasks: [] };
try {
    var savedSomeday = localStorage.getItem(SOMEDAY_KEY);
    if (savedSomeday) somedayState = JSON.parse(savedSomeday);
} catch (e) { }

// Lista "Tareas del cole": tareas de los hijos/as (con hijo/a y fecha
// límite opcionales), agrupadas por hijo/a. Tampoco se resetea cada día.
var schoolState = { tasks: [] };
try {
    var savedSchool = localStorage.getItem(SCHOOL_KEY);
    if (savedSchool) schoolState = JSON.parse(savedSchool);
} catch (e) { }

// Trae automáticamente, una sola vez por día, las tareas que quedaron
// sin realizar en el último día con datos antes de hoy (aunque se
// hayan salteado días, y aunque ese día se haya usado desde OTRO
// dispositivo/navegador: además de mirar el localStorage de este
// dispositivo, más abajo también se consulta Firestore, que es
// donde quedan guardados los días de todos los dispositivos que
// comparten el mismo código de sincronización).
var CARRY_MARK_KEY = "planner-carriedDate-v3";
var carryAlreadyDone = false;
try { carryAlreadyDone = localStorage.getItem(CARRY_MARK_KEY) === dateKey; } catch (e) { }

function markCarryDone() {
    try { localStorage.setItem(CARRY_MARK_KEY, dateKey); } catch (e) { }
}

// Se marca de inmediato que el traslado se está intentando hoy, ANTES de
// hacer nada más (no recién cuando el paso 2 remoto termina bien). Antes,
// si la consulta a Firestore fallaba (por ejemplo, permiso de "list" sin
// aplicar en las reglas), la marca nunca se guardaba y el traslado se
// reintentaba en CADA recarga de la página — reinyectando las mismas
// tareas de "ayer" una y otra vez, sin importar que ya se hubieran
// borrado o movido a "Algún día" mientras tanto. Ahora el traslado se
// intenta como mucho una vez por día calendario, pase lo que pase
// después con la consulta remota.
if (!carryAlreadyDone) markCarryDone();

// Paso 1: lo que este dispositivo tenga guardado localmente del
// último día anterior con datos (rápido, funciona sin conexión).
// Queda accesible más abajo (initFirebaseSync) como respaldo del paso 2.
var localPending = [];
if (!carryAlreadyDone) {
    try {
        var prevKey = findPreviousDayKey(now, dateKey, 30, function (k) {
            return localStorage.getItem("planner-" + k) != null;
        });
        var prevState = prevKey ? JSON.parse(localStorage.getItem("planner-" + prevKey) || "null") : null;
        localPending = prevState && Array.isArray(prevState.tasks)
            ? prevState.tasks.filter(function (t) { return t && !t.done; })
            : [];
        if (applyCarryOver(state, localPending)) saveLocal();
    } catch (e) { }
    // Ojo: todavía NO se marca como hecho acá; el paso 2 (Firestore,
    // más abajo, junto a la sincronización) puede sumar tareas de
    // otros dispositivos y recién ahí se marca el día como resuelto.
}

var taskList = document.getElementById("taskList");
var dial = document.getElementById("dial");
var progressCount = document.getElementById("progressCount");
var taskInput = document.getElementById("taskInput");
var timeInput = document.getElementById("timeInput");
var syncRow = document.getElementById("syncRow");
var syncDot = document.getElementById("syncDot");
var syncLabel = document.getElementById("syncLabel");
var syncCodeText = document.getElementById("syncCodeText");
var syncErrorNote = document.getElementById("syncErrorNote");
var settingsToggle = document.getElementById("settingsToggle");
var settingsDot = document.getElementById("settingsDot");
var dayCompleteEl = document.getElementById("dayComplete");
var somedayTaskList = document.getElementById("somedayTaskList");
var somedayInput = document.getElementById("somedayInput");
var somedaySection = document.getElementById("somedaySection");
var somedayCount = document.getElementById("somedayCount");
var schoolGroups = document.getElementById("schoolGroups");
var schoolInput = document.getElementById("schoolInput");
var schoolChildInput = document.getElementById("schoolChildInput");
var schoolDateInput = document.getElementById("schoolDateInput");
var schoolSection = document.getElementById("schoolSection");
var schoolCount = document.getElementById("schoolCount");
var schoolEmptyState = document.getElementById("schoolEmptyState");

// ---- Ajustes: la fila de sincronización queda oculta hasta que se pida ----
settingsToggle.addEventListener("click", function () {
    syncRow.hidden = !syncRow.hidden;
    settingsToggle.setAttribute("aria-expanded", syncRow.hidden ? "false" : "true");
});

// ---- "Algún día" y "Tareas del cole" desplegables: recuerdan si
// quedaron abiertas o cerradas ----
var SOMEDAY_OPEN_KEY = "planner-somedayOpen";
try { somedaySection.open = localStorage.getItem(SOMEDAY_OPEN_KEY) === "1"; } catch (e) { }
somedaySection.addEventListener("toggle", function () {
    try { localStorage.setItem(SOMEDAY_OPEN_KEY, somedaySection.open ? "1" : "0"); } catch (e) { }
});

var SCHOOL_OPEN_KEY = "planner-schoolOpen";
try { schoolSection.open = localStorage.getItem(SCHOOL_OPEN_KEY) === "1"; } catch (e) { }
schoolSection.addEventListener("toggle", function () {
    try { localStorage.setItem(SCHOOL_OPEN_KEY, schoolSection.open ? "1" : "0"); } catch (e) { }
});

// ---- Cada hijo/a dentro de "Tareas del cole" también es desplegable
// (independiente del resto), y recuerda si quedó abierto o cerrado.
// Abierto por defecto: se guarda solo cuando alguien lo cierra.
var SCHOOL_GROUPS_OPEN_KEY = "planner-schoolGroupsOpen";
var schoolGroupsOpen = {};
try {
    var savedGroupsOpen = JSON.parse(localStorage.getItem(SCHOOL_GROUPS_OPEN_KEY) || "{}");
    if (savedGroupsOpen && typeof savedGroupsOpen === "object") schoolGroupsOpen = savedGroupsOpen;
} catch (e) { }
function saveSchoolGroupsOpen() {
    try { localStorage.setItem(SCHOOL_GROUPS_OPEN_KEY, JSON.stringify(schoolGroupsOpen)); } catch (e) { }
}
function schoolGroupKey(child) {
    return (child || "").trim().toLowerCase() || " sin-asignar";
}
// El evento "toggle" de <details> no burbujea en todos los navegadores,
// así que se escucha en fase de captura para que la delegación funcione
// igual (el recorrido "hacia abajo" sí pasa por #schoolGroups).
schoolGroups.addEventListener("toggle", function (e) {
    var details = e.target.closest(".school-group");
    if (!details) return;
    schoolGroupsOpen[details.getAttribute("data-child-key")] = details.open;
    saveSchoolGroupsOpen();
}, true);

// ---- Estado de sincronización (dot + texto + aviso de error) ----
function setSyncStatus(cls, label) {
    syncDot.className = "sync-dot" + (cls ? " " + cls : "");
    syncLabel.textContent = label;
    settingsDot.className = "icon-btn__dot" + (cls ? " " + cls : "");
}
function showSyncError(msg) {
    syncErrorNote.textContent = msg;
    syncErrorNote.hidden = false;
}
function clearSyncError() {
    syncErrorNote.hidden = true;
    syncErrorNote.textContent = "";
}

// ---- Alternar tema claro/oscuro manualmente ----
var THEME_KEY = "tu-dia-theme";
var themeToggle = document.getElementById("themeToggle");
var THEME_ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'
};
function systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}
function activeTheme() {
    var chosen = document.documentElement.getAttribute("data-theme");
    if (chosen === "light" || chosen === "dark") return chosen;
    return systemPrefersDark() ? "dark" : "light";
}
function paintThemeToggle() {
    var theme = activeTheme();
    // El icono representa el modo al que se cambiará al pulsar.
    themeToggle.innerHTML = theme === "dark" ? THEME_ICONS.sun : THEME_ICONS.moon;
    var label = theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro";
    themeToggle.setAttribute("aria-label", label);
    themeToggle.title = label;
}
if (themeToggle) {
    paintThemeToggle();
    themeToggle.addEventListener("click", function () {
        var next = activeTheme() === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try { localStorage.setItem(THEME_KEY, next); } catch (e) { }
        paintThemeToggle();
    });
    if (window.matchMedia) {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
            if (!document.documentElement.hasAttribute("data-theme")) paintThemeToggle();
        });
    }
}

function saveLocal() {
    try { localStorage.setItem(localStorageKey, JSON.stringify(state)); } catch (e) { }
}
function saveSomedayLocal() {
    try { localStorage.setItem(SOMEDAY_KEY, JSON.stringify(somedayState)); } catch (e) { }
}
function saveSchoolLocal() {
    try { localStorage.setItem(SCHOOL_KEY, JSON.stringify(schoolState)); } catch (e) { }
}

// ---- Edición en línea (reemplaza los prompt()/alert() del navegador) ----
var editingTaskId = null; // id en edición en la lista de hoy
var editingSomedayId = null; // id en edición en la lista "Algún día"
var editingSchoolId = null; // id en edición en "Tareas del cole"

function paint() {
    var nowDate = new Date();
    var nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
    var groups = splitTasksForRender(state.tasks, nowMinutes);
    var moveOpts = { moveLabel: "Mover a Algún día", moveIcon: "&#8658;" };

    function renderTask(t, overdue) {
        return t.id === editingTaskId ? taskEditHtml(t) : taskHtml(t, overdue, moveOpts);
    }

    var html = groups.upcoming.map(function (t) { return renderTask(t, false); }).join("");
    if (groups.overdue.length) {
        html += '<li class="task-divider">⚠ Tareas sin realizar</li>' + groups.overdue.map(function (t) { return renderTask(t, true); }).join("");
    }
    html += groups.done.map(function (t) { return renderTask(t, false); }).join("");

    taskList.innerHTML = html;

    var total = state.tasks.length;
    var doneCount = groups.done.length;
    dial.style.setProperty("--pct", computeDialPct(doneCount, total));
    progressCount.textContent = doneCount + "/" + total;
    dayCompleteEl.classList.toggle("is-visible", isDayComplete(total, doneCount));

    if (editingTaskId) {
        var input = taskList.querySelector(".task--editing .task-edit__text");
        if (input) { input.focus(); input.select(); }
    }
}

function paintSomeday() {
    var groups = splitSomedayForRender(somedayState.tasks);
    var moveOpts = { moveLabel: "Mover a hoy", moveIcon: "&#8656;" };

    function renderTask(t) {
        return t.id === editingSomedayId ? taskEditHtml(t, { showTime: false }) : taskHtml(t, false, moveOpts);
    }

    somedayTaskList.innerHTML = groups.pending.map(renderTask).join("") + groups.done.map(renderTask).join("");
    somedayCount.textContent = groups.pending.length ? "(" + groups.pending.length + ")" : "";

    if (editingSomedayId) {
        var input = somedayTaskList.querySelector(".task--editing .task-edit__text");
        if (input) { input.focus(); input.select(); }
    }
}

function paintSchool() {
    var groups = groupSchoolTasksByChild(schoolState.tasks);
    var moveOpts = { moveLabel: "Mover a hoy", moveIcon: "&#8656;" };
    var total = 0;
    var pendingTotal = 0;

    function renderTask(t) {
        var overdue = isSchoolTaskOverdue(t, dateKey);
        return t.id === editingSchoolId ? schoolTaskEditHtml(t) : schoolTaskHtml(t, overdue, moveOpts);
    }

    schoolGroups.innerHTML = groups.map(function (g) {
        total += g.pending.length + g.done.length;
        pendingTotal += g.pending.length;
        var label = escapeHtml(g.child || "Sin asignar");
        var countLabel = g.pending.length ? " (" + g.pending.length + ")" : "";
        var key = schoolGroupKey(g.child);
        var isOpen = schoolGroupsOpen[key] !== false; // por defecto abierto
        return '<details class="school-group"' + (isOpen ? " open" : "") + ' data-child-key="' + escapeHtml(key) + '">' +
            '<summary class="school-group-label">' + label + countLabel + '</summary>' +
            '<ul class="task-list">' + g.pending.map(renderTask).join("") + g.done.map(renderTask).join("") + '</ul>' +
            '</details>';
    }).join("");

    schoolCount.textContent = pendingTotal ? "(" + pendingTotal + ")" : "";
    schoolEmptyState.classList.toggle("is-visible", total === 0);

    if (editingSchoolId) {
        var input = schoolGroups.querySelector(".task--editing .task-edit__text");
        if (input) { input.focus(); input.select(); }
    }
}

function render() {
    if (!reduceMotion && document.startViewTransition) {
        document.startViewTransition(paint);
    } else {
        paint();
    }
}
function renderSomeday() {
    if (!reduceMotion && document.startViewTransition) {
        document.startViewTransition(paintSomeday);
    } else {
        paintSomeday();
    }
}
function renderSchool() {
    if (!reduceMotion && document.startViewTransition) {
        document.startViewTransition(paintSchool);
    } else {
        paintSchool();
    }
}

document.getElementById("addForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = taskInput.value.trim();
    if (!text) return;
    state.tasks.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        text: text, time: timeInput.value.trim(), done: false, priority: false, order: state.tasks.length
    });
    taskInput.value = ""; timeInput.value = ""; taskInput.focus();
    commit();
});

taskList.addEventListener("click", function (e) {
    if (e.target.closest(".task-edit__cancel")) {
        editingTaskId = null;
        render();
        return;
    }
    if (e.target.closest(".task-edit-form")) return; // clicks dentro del formulario de edición

    var li = e.target.closest(".task");
    if (!li) return;
    var id = li.getAttribute("data-id");
    var task = state.tasks.find(function (t) { return t.id === id; });
    if (!task) return;
    if (e.target.closest(".task__star")) { task.priority = !task.priority; commit(); }
    else if (e.target.closest(".task__move")) {
        state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
        somedayState.tasks.push({
            id: task.id, text: task.text, done: task.done, priority: task.priority,
            order: somedayState.tasks.length
        });
        if (editingTaskId === id) editingTaskId = null;
        commit();
        commitSomeday();
    }
    else if (e.target.closest(".task__edit")) {
        editingTaskId = task.id;
        render();
    }
    else if (e.target.closest(".task__del")) {
        if (editingTaskId === id) editingTaskId = null;
        state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
        commit();
    }
    else { task.done = e.target.classList.contains("task__box") ? e.target.checked : !task.done; commit(); }
});

taskList.addEventListener("submit", function (e) {
    var form = e.target.closest(".task-edit-form");
    if (!form) return;
    e.preventDefault();
    var li = form.closest(".task");
    var id = li && li.getAttribute("data-id");
    var task = state.tasks.find(function (t) { return t.id === id; });
    editingTaskId = null;
    if (!task) { render(); return; }
    var newText = form.querySelector(".task-edit__text").value.trim();
    if (newText) task.text = newText.slice(0, 1000);
    task.time = form.querySelector(".task-edit__time").value || "";
    commit();
});

taskList.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && e.target.closest(".task-edit-form")) {
        editingTaskId = null;
        render();
    }
});

document.getElementById("clearDone").addEventListener("click", function () {
    state.tasks = state.tasks.filter(function (t) { return !t.done; });
    commit();
});

// ---- Lista "Algún día" (reemplaza el cuadro de notas libres) ----
document.getElementById("somedayAddForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = somedayInput.value.trim();
    if (!text) return;
    somedayState.tasks.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        text: text, time: "", done: false, priority: false, order: somedayState.tasks.length
    });
    somedayInput.value = ""; somedayInput.focus();
    commitSomeday();
});

somedayTaskList.addEventListener("click", function (e) {
    if (e.target.closest(".task-edit__cancel")) {
        editingSomedayId = null;
        renderSomeday();
        return;
    }
    if (e.target.closest(".task-edit-form")) return;

    var li = e.target.closest(".task");
    if (!li) return;
    var id = li.getAttribute("data-id");
    var task = somedayState.tasks.find(function (t) { return t.id === id; });
    if (!task) return;
    if (e.target.closest(".task__star")) { task.priority = !task.priority; commitSomeday(); }
    else if (e.target.closest(".task__move")) {
        somedayState.tasks = somedayState.tasks.filter(function (t) { return t.id !== id; });
        state.tasks.push({
            id: task.id, text: task.text, time: "", done: task.done, priority: task.priority,
            order: state.tasks.length
        });
        if (editingSomedayId === id) editingSomedayId = null;
        commitSomeday();
        commit();
    }
    else if (e.target.closest(".task__edit")) {
        editingSomedayId = task.id;
        renderSomeday();
    }
    else if (e.target.closest(".task__del")) {
        if (editingSomedayId === id) editingSomedayId = null;
        somedayState.tasks = somedayState.tasks.filter(function (t) { return t.id !== id; });
        commitSomeday();
    }
    else { task.done = e.target.classList.contains("task__box") ? e.target.checked : !task.done; commitSomeday(); }
});

somedayTaskList.addEventListener("submit", function (e) {
    var form = e.target.closest(".task-edit-form");
    if (!form) return;
    e.preventDefault();
    var li = form.closest(".task");
    var id = li && li.getAttribute("data-id");
    var task = somedayState.tasks.find(function (t) { return t.id === id; });
    editingSomedayId = null;
    if (!task) { renderSomeday(); return; }
    var newText = form.querySelector(".task-edit__text").value.trim();
    if (newText) task.text = newText.slice(0, 1000);
    commitSomeday();
});

somedayTaskList.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && e.target.closest(".task-edit-form")) {
        editingSomedayId = null;
        renderSomeday();
    }
});

// ---- "Tareas del cole" (tareas de los hijos/as, agrupadas por hijo/a) ----
document.getElementById("schoolAddForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var text = schoolInput.value.trim();
    if (!text) return;
    schoolState.tasks.push({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
        text: text, child: schoolChildInput.value.trim(), dueDate: schoolDateInput.value || "",
        done: false, priority: false, order: schoolState.tasks.length
    });
    schoolInput.value = ""; schoolChildInput.value = ""; schoolDateInput.value = ""; schoolInput.focus();
    commitSchool();
});

schoolGroups.addEventListener("click", function (e) {
    if (e.target.closest(".task-edit__cancel")) {
        editingSchoolId = null;
        renderSchool();
        return;
    }
    if (e.target.closest(".task-edit-form")) return;

    var li = e.target.closest(".task");
    if (!li) return;
    var id = li.getAttribute("data-id");
    var task = schoolState.tasks.find(function (t) { return t.id === id; });
    if (!task) return;
    if (e.target.closest(".task__star")) { task.priority = !task.priority; commitSchool(); }
    else if (e.target.closest(".task__move")) {
        schoolState.tasks = schoolState.tasks.filter(function (t) { return t.id !== id; });
        state.tasks.push({
            id: task.id, text: task.child ? task.text + " (" + task.child + ")" : task.text,
            time: "", done: task.done, priority: task.priority, order: state.tasks.length
        });
        if (editingSchoolId === id) editingSchoolId = null;
        commitSchool();
        commit();
    }
    else if (e.target.closest(".task__edit")) {
        editingSchoolId = task.id;
        renderSchool();
    }
    else if (e.target.closest(".task__del")) {
        if (editingSchoolId === id) editingSchoolId = null;
        schoolState.tasks = schoolState.tasks.filter(function (t) { return t.id !== id; });
        commitSchool();
    }
    else { task.done = e.target.classList.contains("task__box") ? e.target.checked : !task.done; commitSchool(); }
});

schoolGroups.addEventListener("submit", function (e) {
    var form = e.target.closest(".task-edit-form");
    if (!form) return;
    e.preventDefault();
    var li = form.closest(".task");
    var id = li && li.getAttribute("data-id");
    var task = schoolState.tasks.find(function (t) { return t.id === id; });
    editingSchoolId = null;
    if (!task) { renderSchool(); return; }
    var newText = form.querySelector(".task-edit__text").value.trim();
    if (newText) task.text = newText.slice(0, 1000);
    task.child = form.querySelector(".task-edit__child").value.trim();
    task.dueDate = form.querySelector(".task-edit__date").value || "";
    commitSchool();
});

schoolGroups.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && e.target.closest(".task-edit-form")) {
        editingSchoolId = null;
        renderSchool();
    }
});

function flash(btn, msg) {
    var original = btn.textContent;
    btn.textContent = msg; btn.disabled = true;
    setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 1800);
}

// ---- Exportar / Importar (respaldo manual, funciona en cualquier navegador) ----
var exportBtn = document.getElementById("exportBtn");
var importBtn = document.getElementById("importBtn");
var importFile = document.getElementById("importFile");

exportBtn.addEventListener("click", function () {
    var payload = JSON.stringify({
        tasks: state.tasks, somedayTasks: somedayState.tasks, schoolTasks: schoolState.tasks,
        date: dateKey, exportedAt: new Date().toISOString()
    }, null, 2);
    if (window.claude && window.claude.downloads) {
        window.claude.downloads.save({ filename: "tu-dia-" + dateKey + ".json", data: payload })
            .then(function () { flash(exportBtn, "Exportado ✓"); })
            .catch(function (err) { if (!(err && err.code === "declined")) flash(exportBtn, "No se pudo exportar"); });
    } else {
        var blob = new Blob([payload], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = "tu-dia-" + dateKey + ".json";
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        flash(exportBtn, "Exportado ✓");
    }
});

importBtn.addEventListener("click", function () { importFile.click(); });
importFile.addEventListener("change", function () {
    var file = importFile.files && importFile.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        try {
            var incoming = JSON.parse(String(reader.result));
            mergeState(incoming);
            commit();
            commitSomeday();
            commitSchool();
            flash(importBtn, "Importado ✓");
        } catch (e) { flash(importBtn, "Archivo no válido"); }
        importFile.value = "";
    };
    reader.onerror = function () { flash(importBtn, "No se pudo leer"); };
    reader.readAsText(file);
});

// extraFields: nombres de campos de texto adicionales a copiar tal cual
// desde el objeto de origen (usado para child/dueDate en "Tareas del
// cole"; las listas de hoy y "Algún día" no lo necesitan).
function mergeTasksInto(targetTasks, incomingTasks, extraFields) {
    var existingIds = {};
    targetTasks.forEach(function (t) { existingIds[t.id] = true; });
    var offset = targetTasks.length;
    var added = 0;
    incomingTasks.forEach(function (t, i) {
        if (!t || typeof t.text !== "string" || !t.text.trim()) return;
        if (t.id && existingIds[t.id]) return;
        var task = {
            id: t.id || (Date.now() + "-" + Math.random().toString(36).slice(2, 7)),
            text: t.text.slice(0, 1000), time: typeof t.time === "string" ? t.time.slice(0, 12) : "",
            done: !!t.done, priority: !!t.priority, order: offset + added
        };
        (extraFields || []).forEach(function (field) {
            task[field] = typeof t[field] === "string" ? t[field].slice(0, 40) : "";
        });
        targetTasks.push(task);
        added++;
    });
}

function mergeState(incoming) {
    mergeTasksInto(state.tasks, Array.isArray(incoming.tasks) ? incoming.tasks : []);
    mergeTasksInto(somedayState.tasks, Array.isArray(incoming.somedayTasks) ? incoming.somedayTasks : []);
    mergeTasksInto(schoolState.tasks, Array.isArray(incoming.schoolTasks) ? incoming.schoolTasks : [], ["child", "dueDate"]);
}

// ======================================================================
// 2) SINCRONIZACIÓN ENTRE DISPOSITIVOS (Firebase Firestore)
//    Todos los dispositivos que usen el MISMO "código" comparten los
//    mismos datos del día (y las listas "Algún día" y "Tareas del cole")
//    en tiempo real.
// ======================================================================
var CODE_KEY = "tu-dia-sync-code";
function randomCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var out = "";
    for (var i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
var syncCode = localStorage.getItem(CODE_KEY);
if (!syncCode) { syncCode = randomCode(); localStorage.setItem(CODE_KEY, syncCode); }
syncCodeText.textContent = syncCode;

document.getElementById("copyCodeBtn").addEventListener("click", function () {
    navigator.clipboard.writeText(syncCode).then(function () {
        flash(document.getElementById("copyCodeBtn"), "Copiado ✓");
    }).catch(function () { });
});
document.getElementById("joinCodeBtn").addEventListener("click", function () {
    var input = prompt("Escribe el código que se muestra en tu otro dispositivo:", syncCode);
    if (!input) return;
    var clean = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (clean.length < 6) { alert("Código no válido."); return; }
    localStorage.setItem(CODE_KEY, clean);
    location.reload();
});

var db = null, docRef = null, somedayDocRef = null, schoolDocRef = null, remoteReady = false;
var applyingRemote = false, applyingSomedayRemote = false, applyingSchoolRemote = false;
var isConfigured = FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey.indexOf("PEGA_AQUI") === -1;

// ---- Fábrica de guardado remoto con reintento automático (backoff) ----
// Se usa una instancia por cada lista (hoy, "Algún día", "Tareas del
// cole"), así cada una reintenta de forma independiente si falla su
// guardado.
function createRemoteSync(getRef, getPayload) {
    var retryTimer = null, retryDelay = 5000, retryCount = 0;
    var MAX_RETRIES = 5;
    function push() {
        var ref = getRef();
        if (!ref || !setDocFn) return;
        setDocFn(ref, getPayload(), { merge: false })
            .then(function () {
                retryCount = 0;
                retryDelay = 5000;
                clearTimeout(retryTimer);
                clearSyncError();
            })
            .catch(function (err) {
                console.error("No se pudo guardar en la nube:", err);
                scheduleRetry();
            });
    }
    function scheduleRetry() {
        clearTimeout(retryTimer);
        if (retryCount >= MAX_RETRIES) {
            showSyncError("No se pudo guardar en la nube. Tus cambios quedaron en este dispositivo; revisá tu conexión.");
            return;
        }
        showSyncError("No se pudo guardar en la nube, reintentando…");
        retryTimer = setTimeout(function () {
            retryCount++;
            retryDelay = Math.min(retryDelay * 2, 80000);
            push();
        }, retryDelay);
    }
    function retryNow() {
        retryCount = 0;
        retryDelay = 5000;
        push();
    }
    return { push: push, retryNow: retryNow };
}

var dailySync = createRemoteSync(
    function () { return docRef; },
    function () { return { tasks: state.tasks, updatedAt: Date.now() }; }
);
var somedaySync = createRemoteSync(
    function () { return somedayDocRef; },
    function () { return { tasks: somedayState.tasks, updatedAt: Date.now() }; }
);
var schoolSync = createRemoteSync(
    function () { return schoolDocRef; },
    function () { return { tasks: schoolState.tasks, updatedAt: Date.now() }; }
);
function pushRemote() { dailySync.push(); }
function pushSomedayRemote() { somedaySync.push(); }
function pushSchoolRemote() { schoolSync.push(); }

window.addEventListener("online", function () {
    if (!syncErrorNote.hidden) {
        dailySync.retryNow();
        somedaySync.retryNow();
        schoolSync.retryNow();
    }
});

async function initFirebaseSync() {
    var appMod, fsMod;
    try {
        appMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
        fsMod = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    } catch (e) {
        // El CDN de Firebase no cargó (sin conexión, red que lo bloquea,
        // CDN caído). La app sigue funcionando en modo solo local: las
        // tareas se siguen guardando en este dispositivo con localStorage.
        console.error("No se pudieron cargar los módulos de Firebase:", e);
        setSyncStatus("err", "Sin conexión con la nube (solo local)");
        showSyncError("No se pudo cargar Firebase. Tus tareas se siguen guardando en este dispositivo.");
        return;
    }

    var initializeApp = appMod.initializeApp;
    var getFirestore = fsMod.getFirestore, doc = fsMod.doc, getDoc = fsMod.getDoc, onSnapshot = fsMod.onSnapshot;
    var enableIndexedDbPersistence = fsMod.enableIndexedDbPersistence;
    setDocFn = fsMod.setDoc;

    try {
        var app = initializeApp(FIREBASE_CONFIG);
        db = getFirestore(app);
        try { enableIndexedDbPersistence(db); } catch (e) { }
        docRef = doc(db, "planners", syncCode, "days", dateKey);
        somedayDocRef = doc(db, "planners", syncCode, "someday", "list");
        schoolDocRef = doc(db, "planners", syncCode, "school", "list");

        setSyncStatus("", "Conectando…");

        // Paso 2: busca en Firestore el día más reciente anterior a hoy
        // (con datos de CUALQUIER dispositivo que use este mismo código),
        // por si este dispositivo no tenía esos datos en su propio
        // localStorage. Se espera a que termine ANTES de suscribirse al
        // snapshot en tiempo real (más abajo): si no se esperara, el
        // primer snapshot remoto podía llegar antes de tener esta lista,
        // reemplazar el estado local ya trasladado por uno sin trasladar,
        // y pintarlo así — el traslado "aparecía un segundo y desaparecía".
        //
        // Se implementa con lecturas directas por fecha (getDoc), en vez
        // de una consulta (query + where + orderBy) sobre la colección:
        // esa consulta necesita un índice compuesto que Firestore no crea
        // solo, y sin él fallaba con "FAILED_PRECONDITION: the query
        // requires an index" en cualquier proyecto que no lo haya creado
        // a mano. Las lecturas directas por id nunca necesitan índice.
        //
        // Usa localPending (lo que ya se encontró en el paso 1) como valor
        // de respaldo si la consulta a la nube falla o no encuentra nada.
        var remoteCarryPending = localPending;
        if (!carryAlreadyDone) {
            try {
                var candidateKeys = [];
                for (var i = 1; i <= 30; i++) {
                    var d = new Date(now);
                    d.setDate(d.getDate() - i);
                    candidateKeys.push(formatDateKey(d));
                }
                var results = await Promise.allSettled(candidateKeys.map(function (key) {
                    return getDoc(doc(db, "planners", syncCode, "days", key)).then(function (snap) {
                        return { key: key, snap: snap };
                    });
                }));
                var anyFulfilled = false;
                var found = null;
                for (var j = 0; j < results.length; j++) {
                    if (results[j].status !== "fulfilled") continue;
                    anyFulfilled = true;
                    // candidateKeys ya está en orden de más reciente a más
                    // vieja, así que el primer resultado existente es el
                    // día anterior más reciente con datos.
                    if (results[j].value.snap.exists()) { found = results[j].value; break; }
                }
                if (!anyFulfilled) {
                    throw new Error("No se pudo leer ningún día anterior en la nube (conexión o permisos).");
                }
                if (found) {
                    var docData = found.snap.data();
                    var cloudPending = Array.isArray(docData.tasks)
                        ? docData.tasks.filter(function (t) { return t && !t.done; })
                        : [];
                    if (cloudPending.length) remoteCarryPending = cloudPending;
                }
            } catch (err) {
                // El traslado de hoy ya quedó marcado como intentado (más
                // arriba, antes de llegar acá) aunque esto falle: no tiene
                // reintento en la próxima carga a propósito, para no
                // reinyectar sin parar las mismas tareas de "ayer". Se
                // sigue usando localPending, y se avisa en vez de fallar
                // en silencio.
                console.error("No se pudo revisar el día anterior en la nube:", err);
                showSyncError("No se pudo revisar la nube por tareas de días anteriores; se usó lo que había en este dispositivo.");
            }
        }

        onSnapshot(docRef, function (snap) {
            remoteReady = true;
            setSyncStatus("ok", "Sincronizado");
            clearSyncError();
            if (snap.exists()) {
                var remote = snap.data();
                applyingRemote = true;
                state = { tasks: remote.tasks || [] };
                // El estado remoto reemplaza por completo al local: si el
                // traslado de ayer todavía no se aplicó a un estado "real"
                // (por ejemplo, este remoto es de antes de tener esta
                // función), se aplica ahora para que no se pierda.
                // OJO: esto solo puede pasar UNA vez — remoteCarryPending
                // se vacía enseguida. onSnapshot se vuelve a disparar con
                // cada cambio (incluido el eco del propio guardado al
                // borrar/editar una tarea), y si no se vaciara, cualquier
                // tarea trasladada que se borrara volvería a agregarse
                // sola en la próxima actualización, sin importar qué la
                // haya disparado.
                var carried = applyCarryOver(state, remoteCarryPending);
                remoteCarryPending = null;
                saveLocal();
                if (!editingTaskId) render();
                applyingRemote = false;
                if (carried) pushRemote();
            } else {
                // No hay nada remoto todavía: sube lo que tengas en local.
                pushRemote();
            }
        }, function (err) {
            setSyncStatus("err", "Error de sincronización");
            console.error("Firestore error:", err);
            showSyncError("No se pudo conectar con la nube. Tus cambios se siguen guardando en este dispositivo.");
        });

        onSnapshot(somedayDocRef, function (snap) {
            if (snap.exists()) {
                var remote = snap.data();
                applyingSomedayRemote = true;
                somedayState = { tasks: remote.tasks || [] };
                saveSomedayLocal();
                if (!editingSomedayId) renderSomeday();
                applyingSomedayRemote = false;
            } else {
                pushSomedayRemote();
            }
        }, function (err) {
            console.error("Firestore error (Algún día):", err);
        });

        onSnapshot(schoolDocRef, function (snap) {
            if (snap.exists()) {
                var remote = snap.data();
                applyingSchoolRemote = true;
                schoolState = { tasks: remote.tasks || [] };
                saveSchoolLocal();
                if (!editingSchoolId) renderSchool();
                applyingSchoolRemote = false;
            } else {
                pushSchoolRemote();
            }
        }, function (err) {
            console.error("Firestore error (Tareas del cole):", err);
        });
    } catch (e) {
        setSyncStatus("err", "Error de configuración");
        console.error(e);
    }
}

if (!isConfigured) {
    setSyncStatus("err", "Sin configurar (solo local)");
} else {
    initFirebaseSync();
}

function commit() {
    saveLocal();
    render();
    if (applyingRemote) return;
    pushRemote();
}
function commitSomeday() {
    saveSomedayLocal();
    renderSomeday();
    if (applyingSomedayRemote) return;
    pushSomedayRemote();
}
function commitSchool() {
    saveSchoolLocal();
    renderSchool();
    if (applyingSchoolRemote) return;
    pushSchoolRemote();
}

paint();
paintSomeday();
paintSchool();

// Revisa cada minuto si alguna tarea pendiente ya venció su hora, para
// moverla automáticamente a "Tareas sin realizar" sin recargar. Se
// omite mientras se está editando una tarea, para no perder cambios sin
// guardar.
setInterval(function () { if (!editingTaskId) render(); }, 60000);
