// ============================================================================
// Lógica pura de "Tu día": funciones sin DOM ni red, fáciles de testear.
// Todo lo que toca el navegador (localStorage, Firestore, elementos HTML)
// vive en app.js, que importa y usa estas funciones.
// ============================================================================

/** Escapa texto para insertarlo de forma segura dentro de HTML. */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Convierte "14:30", "2:30pm", "9am", etc. a minutos desde medianoche.
 * Devuelve null si el texto no se pudo interpretar como hora (o está vacío).
 */
export function parseTimeToMinutes(str) {
    if (!str) return null;
    var s = str.trim().toLowerCase().replace(/\./g, "");
    var m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var min = m[2] ? parseInt(m[2], 10) : 0;
    var ap = m[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

/** Da formato HH:MM (24h) a una cantidad de minutos desde medianoche. */
export function formatMinutesAsTime(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

export function byTimeThenOrder(a, b) {
    var ta = parseTimeToMinutes(a.time), tb = parseTimeToMinutes(b.time);
    if (ta === null && tb === null) return a.order - b.order;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb || a.order - b.order;
}

/** Una tarea está "vencida" si tiene hora, esa hora ya pasó y no está hecha. */
export function isOverdue(t, nowMinutes) {
    if (t.done) return false;
    var tm = parseTimeToMinutes(t.time);
    return tm !== null && tm < nowMinutes;
}

/** Da formato "YYYY-MM-DD" a una fecha, en hora local. */
export function formatDateKey(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Busca, yendo hacia atrás desde "now", la clave del día más reciente
 * (antes de dateKey) para el que hayFn(key) devuelva true. hasDayFn se
 * recibe como parámetro para no acoplar esta función a localStorage/red,
 * y así poder testearla con datos en memoria.
 */
export function findPreviousDayKey(now, dateKey, maxDays, hasDayFn) {
    for (var i = 1; i <= maxDays; i++) {
        var d = new Date(now);
        d.setDate(d.getDate() - i);
        var key = formatDateKey(d);
        if (key !== dateKey && hasDayFn(key)) return key;
    }
    return null;
}

/**
 * Fusiona tasksToCarry dentro de targetState.tasks, descartando por id los
 * que ya estén presentes (así se puede llamar varias veces con distintas
 * fuentes -local y remota- sin duplicar nada). Las tareas trasladadas
 * quedan marcadas con carried:true, para poder mostrar una insignia en la
 * interfaz. Devuelve true si agregó alguna.
 */
export function applyCarryOver(targetState, tasksToCarry) {
    if (!tasksToCarry || !tasksToCarry.length) return false;
    var existingIds = {};
    targetState.tasks.forEach(function (t) { existingIds[t.id] = true; });
    var offset = targetState.tasks.length;
    var added = false;
    tasksToCarry.forEach(function (t, i) {
        if (t.id && existingIds[t.id]) return;
        targetState.tasks.push({
            id: t.id || (Date.now() + "-" + Math.random().toString(36).slice(2, 7)),
            text: t.text, time: t.time || "",
            done: false, priority: !!t.priority, order: offset + i,
            carried: true
        });
        added = true;
    });
    return added;
}

/**
 * Separa las tareas de hoy en tres grupos para pintarlas: próximas
 * (pendientes, a tiempo), vencidas (pendientes, hora ya pasada) y hechas.
 * Las dos primeras se devuelven ordenadas por hora.
 */
export function splitTasksForRender(tasks, nowMinutes) {
    var pendingAll = tasks.filter(function (t) { return !t.done; });
    var overdue = pendingAll.filter(function (t) { return isOverdue(t, nowMinutes); }).sort(byTimeThenOrder);
    var upcoming = pendingAll.filter(function (t) { return !isOverdue(t, nowMinutes); }).sort(byTimeThenOrder);
    var done = tasks.filter(function (t) { return t.done; }).sort(byTimeThenOrder);
    return { upcoming: upcoming, overdue: overdue, done: done };
}

/** Porcentaje (0-100, redondeado) de tareas completadas. */
export function computeDialPct(doneCount, total) {
    return total ? Math.round((doneCount / total) * 100) : 0;
}

/** true si hay al menos una tarea y todas están completadas. */
export function isDayComplete(total, doneCount) {
    return total > 0 && doneCount === total;
}

/**
 * HTML de una tarea, en modo lectura normal (no edición).
 * opts.moveLabel / opts.moveIcon: si se pasan, agrega un botón "mover"
 * (usado para pasar tareas entre la lista de hoy y la de "Sin fecha").
 */
export function taskHtml(t, overdue, opts) {
    opts = opts || {};
    var classes = "task" + (t.done ? " task--done" : "") + (t.priority ? " task--priority" : "") + (overdue ? " task--overdue" : "");
    var moveBtn = opts.moveLabel
        ? '<button type="button" class="task__move" aria-label="' + escapeHtml(opts.moveLabel) + '" title="' + escapeHtml(opts.moveLabel) + '">' + (opts.moveIcon || "&#8594;") + '</button>'
        : "";
    return '<li class="' + classes + '" data-id="' + escapeHtml(t.id) + '">' +
        '<label class="task__box-wrap"><input type="checkbox" class="task__box" ' + (t.done ? "checked" : "") + ' aria-label="Marcar como hecho" /></label>' +
        '<span class="task__text">' + escapeHtml(t.text) +
        (t.carried ? ' <span class="task__badge" title="Trasladada de un día anterior">de ayer</span>' : "") +
        '</span>' +
        (t.time ? '<span class="task__time">' + escapeHtml(t.time) + '</span>' : "") +
        '<span class="task__actions">' +
        '<button type="button" class="task__star" aria-pressed="' + (t.priority ? "true" : "false") + '" aria-label="Destacar tarea" title="Destacar">&#9679;</button>' +
        moveBtn +
        '<button type="button" class="task__edit" aria-label="Editar tarea" title="Editar">&#9998;</button>' +
        '<button type="button" class="task__del" aria-label="Eliminar tarea" title="Eliminar">&times;</button>' +
        '</span></li>';
}

/**
 * HTML de una tarea en modo edición (texto, y hora si opts.showTime no es
 * false, editables en línea).
 */
export function taskEditHtml(t, opts) {
    opts = opts || {};
    var showTime = opts.showTime !== false;
    return '<li class="task task--editing" data-id="' + escapeHtml(t.id) + '">' +
        '<form class="task-edit-form">' +
        '<input type="text" class="task-edit__text" value="' + escapeHtml(t.text) + '" maxlength="140" aria-label="Texto de la tarea" />' +
        (showTime ? '<input type="time" class="task-edit__time" value="' + escapeHtml(t.time || "") + '" aria-label="Hora de la tarea" />' : "") +
        '<button type="submit" class="task-edit__save" aria-label="Guardar" title="Guardar">&#10003;</button>' +
        '<button type="button" class="task-edit__cancel" aria-label="Cancelar" title="Cancelar">&times;</button>' +
        '</form></li>';
}

/**
 * Separa las tareas de la lista "Sin fecha" en pendientes y hechas,
 * ordenadas por el orden en que se agregaron (no tienen hora ni pueden
 * estar "vencidas").
 */
export function splitSomedayForRender(tasks) {
    var pending = tasks.filter(function (t) { return !t.done; }).sort(function (a, b) { return a.order - b.order; });
    var done = tasks.filter(function (t) { return t.done; }).sort(function (a, b) { return a.order - b.order; });
    return { pending: pending, done: done };
}
