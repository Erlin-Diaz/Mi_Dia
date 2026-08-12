// Tests de la lógica pura de la app (js/logic.mjs), usando el test runner
// incorporado de Node (sin dependencias externas). Se corren con:
//   npm test
// o directamente:
//   node --test tests/

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    escapeHtml,
    parseTimeToMinutes,
    formatMinutesAsTime,
    byTimeThenOrder,
    isOverdue,
    formatDateKey,
    findPreviousDayKey,
    applyCarryOver,
    splitTasksForRender,
    computeDialPct,
    isDayComplete,
    taskHtml,
    taskEditHtml,
    splitSomedayForRender,
    formatShortDate,
    isSchoolTaskOverdue,
    groupSchoolTasksByChild,
    schoolTaskHtml,
    schoolTaskEditHtml,
    SCHOOL_CHILDREN,
    schoolChildOptionsHtml,
} from "../js/logic.mjs";

describe("escapeHtml", function () {
    test("escapa etiquetas y comillas", function () {
        assert.equal(
            escapeHtml("<script>alert('hi')</script> \"quote\" & amp"),
            "&lt;script&gt;alert(&#39;hi&#39;)&lt;/script&gt; &quot;quote&quot; &amp; amp"
        );
    });
    test("no rompe con texto normal", function () {
        assert.equal(escapeHtml("Comprar pan"), "Comprar pan");
    });
});

describe("parseTimeToMinutes", function () {
    test("interpreta HH:MM 24h", function () {
        assert.equal(parseTimeToMinutes("14:30"), 14 * 60 + 30);
    });
    test("interpreta 12h con am/pm", function () {
        assert.equal(parseTimeToMinutes("2:30pm"), 14 * 60 + 30);
        assert.equal(parseTimeToMinutes("9am"), 9 * 60);
        assert.equal(parseTimeToMinutes("12am"), 0);
        assert.equal(parseTimeToMinutes("12pm"), 12 * 60);
    });
    test("devuelve null para vacío o inválido", function () {
        assert.equal(parseTimeToMinutes(""), null);
        assert.equal(parseTimeToMinutes(null), null);
        assert.equal(parseTimeToMinutes("no es una hora"), null);
        assert.equal(parseTimeToMinutes("25:00"), null);
        assert.equal(parseTimeToMinutes("10:99"), null);
    });
});

describe("formatMinutesAsTime", function () {
    test("da formato HH:MM con ceros a la izquierda", function () {
        assert.equal(formatMinutesAsTime(5), "00:05");
        assert.equal(formatMinutesAsTime(9 * 60 + 5), "09:05");
        assert.equal(formatMinutesAsTime(23 * 60 + 59), "23:59");
    });
});

describe("byTimeThenOrder", function () {
    test("ordena por hora, y sin hora al final por 'order'", function () {
        var tasks = [
            { text: "sin hora 1", time: "", order: 0 },
            { text: "14:00", time: "14:00", order: 1 },
            { text: "sin hora 2", time: "", order: 2 },
            { text: "09:00", time: "09:00", order: 3 },
        ];
        var sorted = tasks.slice().sort(byTimeThenOrder);
        assert.deepEqual(sorted.map(function (t) { return t.text; }), [
            "09:00", "14:00", "sin hora 1", "sin hora 2",
        ]);
    });
});

describe("isOverdue", function () {
    test("una tarea hecha nunca está vencida", function () {
        assert.equal(isOverdue({ done: true, time: "08:00" }, 9 * 60), false);
    });
    test("sin hora nunca está vencida", function () {
        assert.equal(isOverdue({ done: false, time: "" }, 9 * 60), false);
    });
    test("vencida si la hora ya pasó y no está hecha", function () {
        assert.equal(isOverdue({ done: false, time: "08:00" }, 9 * 60), true);
        assert.equal(isOverdue({ done: false, time: "10:00" }, 9 * 60), false);
    });
});

describe("formatDateKey / findPreviousDayKey", function () {
    test("formatDateKey da formato YYYY-MM-DD", function () {
        assert.equal(formatDateKey(new Date("2026-08-10T12:00:00")), "2026-08-10");
    });
    test("encuentra el día anterior más reciente con datos", function () {
        var now = new Date("2026-08-14T09:00:00");
        var dateKey = formatDateKey(now);
        var daysWithData = { "2026-08-09": true, "2026-08-12": true };
        var found = findPreviousDayKey(now, dateKey, 30, function (k) { return !!daysWithData[k]; });
        assert.equal(found, "2026-08-12"); // el más reciente, no el primero que aparece
    });
    test("devuelve null si no hay ningún día anterior con datos", function () {
        var now = new Date("2026-08-14T09:00:00");
        var dateKey = formatDateKey(now);
        var found = findPreviousDayKey(now, dateKey, 30, function () { return false; });
        assert.equal(found, null);
    });
    test("nunca devuelve la fecha de hoy", function () {
        var now = new Date("2026-08-14T09:00:00");
        var dateKey = formatDateKey(now);
        var found = findPreviousDayKey(now, dateKey, 30, function (k) { return true; });
        assert.notEqual(found, dateKey);
    });
});

describe("applyCarryOver", function () {
    test("agrega tareas pendientes marcándolas como carried", function () {
        var state = { tasks: [] };
        var added = applyCarryOver(state, [{ id: "a", text: "Informe", time: "10:00", priority: true }]);
        assert.equal(added, true);
        assert.equal(state.tasks.length, 1);
        assert.equal(state.tasks[0].carried, true);
        assert.equal(state.tasks[0].done, false);
        assert.equal(state.tasks[0].priority, true);
    });
    test("no duplica si el id ya existe en el destino", function () {
        var state = { tasks: [{ id: "a", text: "Informe", done: false }] };
        var added = applyCarryOver(state, [{ id: "a", text: "Informe (otra copia)" }]);
        assert.equal(added, false);
        assert.equal(state.tasks.length, 1);
    });
    test("es un no-op con lista vacía o nula", function () {
        var state = { tasks: [{ id: "a", text: "x" }] };
        assert.equal(applyCarryOver(state, []), false);
        assert.equal(applyCarryOver(state, null), false);
        assert.equal(state.tasks.length, 1);
    });
});

describe("splitTasksForRender", function () {
    var nowMinutes = 9 * 60; // 09:00
    var tasks = [
        { id: "1", text: "Vencida", time: "08:00", done: false, order: 0 },
        { id: "2", text: "Próxima", time: "10:00", done: false, order: 1 },
        { id: "3", text: "Hecha", time: "07:00", done: true, order: 2 },
        { id: "4", text: "Sin hora", time: "", done: false, order: 3 },
    ];
    test("clasifica correctamente en los tres grupos", function () {
        var groups = splitTasksForRender(tasks, nowMinutes);
        assert.deepEqual(groups.overdue.map(function (t) { return t.id; }), ["1"]);
        assert.deepEqual(groups.upcoming.map(function (t) { return t.id; }), ["2", "4"]);
        assert.deepEqual(groups.done.map(function (t) { return t.id; }), ["3"]);
    });
});

describe("computeDialPct / isDayComplete", function () {
    test("computeDialPct redondea el porcentaje", function () {
        assert.equal(computeDialPct(1, 3), 33);
        assert.equal(computeDialPct(0, 0), 0);
        assert.equal(computeDialPct(2, 2), 100);
    });
    test("isDayComplete requiere al menos una tarea y todas hechas", function () {
        assert.equal(isDayComplete(0, 0), false);
        assert.equal(isDayComplete(3, 2), false);
        assert.equal(isDayComplete(3, 3), true);
    });
});

describe("taskHtml", function () {
    test("escapa el texto de la tarea", function () {
        var html = taskHtml({ id: "1", text: "<b>hola</b>", done: false, priority: false }, false);
        assert.ok(html.includes("&lt;b&gt;hola&lt;/b&gt;"));
        assert.ok(!html.includes("<b>hola</b>"));
    });
    test("agrega la clase task--overdue solo si se pide", function () {
        var t = { id: "1", text: "x", done: false, priority: false };
        assert.ok(taskHtml(t, true).includes("task--overdue"));
        assert.ok(!taskHtml(t, false).includes("task--overdue"));
    });
    test("muestra la insignia 'de ayer' solo si carried:true", function () {
        var base = { id: "1", text: "x", done: false, priority: false };
        assert.ok(!taskHtml(base, false).includes("task__badge"));
        assert.ok(taskHtml(Object.assign({}, base, { carried: true }), false).includes("task__badge"));
    });
    test("agrega el botón de mover solo si se pasa moveLabel", function () {
        var t = { id: "1", text: "x", done: false, priority: false };
        assert.ok(!taskHtml(t, false).includes("task__move"));
        var html = taskHtml(t, false, { moveLabel: "Mover a Algún día" });
        assert.ok(html.includes("task__move"));
        assert.ok(html.includes("Mover a Algún día"));
    });
});

describe("taskEditHtml", function () {
    var t = { id: "1", text: "Comprar pan", time: "08:00" };
    test("incluye el input de hora por defecto", function () {
        assert.ok(taskEditHtml(t).includes("task-edit__time"));
    });
    test("omite el input de hora si showTime es false", function () {
        var html = taskEditHtml(t, { showTime: false });
        assert.ok(!html.includes("task-edit__time"));
        assert.ok(html.includes("task-edit__text")); // el texto se sigue pudiendo editar
    });
});

describe("splitSomedayForRender", function () {
    test("separa pendientes y hechas, ordenadas por 'order'", function () {
        var tasks = [
            { id: "1", text: "b", done: false, order: 1 },
            { id: "2", text: "a", done: false, order: 0 },
            { id: "3", text: "hecha", done: true, order: 2 },
        ];
        var groups = splitSomedayForRender(tasks);
        assert.deepEqual(groups.pending.map(function (t) { return t.id; }), ["2", "1"]);
        assert.deepEqual(groups.done.map(function (t) { return t.id; }), ["3"]);
    });
});

describe("formatShortDate", function () {
    test("da formato corto en español", function () {
        assert.equal(formatShortDate("2026-08-14"), "14 ago");
        assert.equal(formatShortDate("2026-01-05"), "5 ene");
    });
    test("devuelve '' para vacío o inválido", function () {
        assert.equal(formatShortDate(""), "");
        assert.equal(formatShortDate(null), "");
        assert.equal(formatShortDate("no es una fecha"), "");
    });
});

describe("isSchoolTaskOverdue", function () {
    test("vencida si la fecha límite ya pasó y no está hecha", function () {
        assert.equal(isSchoolTaskOverdue({ done: false, dueDate: "2026-08-09" }, "2026-08-10"), true);
        assert.equal(isSchoolTaskOverdue({ done: false, dueDate: "2026-08-10" }, "2026-08-10"), false);
        assert.equal(isSchoolTaskOverdue({ done: false, dueDate: "2026-08-11" }, "2026-08-10"), false);
    });
    test("una tarea hecha nunca está vencida", function () {
        assert.equal(isSchoolTaskOverdue({ done: true, dueDate: "2026-08-09" }, "2026-08-10"), false);
    });
    test("sin fecha límite nunca está vencida", function () {
        assert.equal(isSchoolTaskOverdue({ done: false, dueDate: "" }, "2026-08-10"), false);
    });
});

describe("groupSchoolTasksByChild", function () {
    test("agrupa por hijo/a, normalizando mayúsculas para no duplicar grupos", function () {
        var tasks = [
            { id: "1", text: "Tarea 1", child: "Adriana", done: false, order: 0 },
            { id: "2", text: "Tarea 2", child: "adriana", done: false, order: 1 },
            { id: "3", text: "Tarea 3", child: "Andrés", done: false, order: 0 },
        ];
        var groups = groupSchoolTasksByChild(tasks);
        assert.equal(groups.length, 2);
        var adriana = groups.find(function (g) { return g.child === "Adriana"; });
        assert.ok(adriana);
        assert.equal(adriana.pending.length, 2); // "Adriana" y "adriana" quedan en el mismo grupo
    });
    test("las tareas sin hijo/a van a un grupo 'Sin asignar' al final", function () {
        var tasks = [
            { id: "1", text: "Con hijo", child: "Andrés", done: false, order: 0 },
            { id: "2", text: "Sin hijo", child: "", done: false, order: 0 },
        ];
        var groups = groupSchoolTasksByChild(tasks);
        assert.equal(groups[groups.length - 1].child, "");
        assert.equal(groups[groups.length - 1].pending[0].text, "Sin hijo");
    });
    test("separa pendientes y hechas dentro de cada grupo, ordenadas por 'order'", function () {
        var tasks = [
            { id: "1", text: "b", child: "Andrés", done: false, order: 1 },
            { id: "2", text: "a", child: "Andrés", done: false, order: 0 },
            { id: "3", text: "hecha", child: "Andrés", done: true, order: 0 },
        ];
        var groups = groupSchoolTasksByChild(tasks);
        assert.deepEqual(groups[0].pending.map(function (t) { return t.id; }), ["2", "1"]);
        assert.deepEqual(groups[0].done.map(function (t) { return t.id; }), ["3"]);
    });
});

describe("schoolTaskHtml", function () {
    test("muestra la fecha límite formateada cuando hay una", function () {
        var html = schoolTaskHtml({ id: "1", text: "x", dueDate: "2026-08-14", done: false, priority: false }, false);
        assert.ok(html.includes("14 ago"));
    });
    test("no muestra fecha si no tiene dueDate", function () {
        var html = schoolTaskHtml({ id: "1", text: "x", dueDate: "", done: false, priority: false }, false);
        assert.ok(!html.includes("task__time"));
    });
    test("agrega la clase task--overdue solo si se pide", function () {
        var t = { id: "1", text: "x", dueDate: "2026-08-01", done: false, priority: false };
        assert.ok(schoolTaskHtml(t, true).includes("task--overdue"));
        assert.ok(!schoolTaskHtml(t, false).includes("task--overdue"));
    });
    test("escapa el texto de la tarea", function () {
        var html = schoolTaskHtml({ id: "1", text: "<b>hola</b>", done: false, priority: false }, false);
        assert.ok(html.includes("&lt;b&gt;hola&lt;/b&gt;"));
    });
});

describe("schoolTaskEditHtml", function () {
    test("incluye inputs de texto, hijo/a y fecha", function () {
        var html = schoolTaskEditHtml({ id: "1", text: "Tarea", child: "Adriana", dueDate: "2026-08-14" });
        assert.ok(html.includes("task-edit__text"));
        assert.ok(html.includes("task-edit__child"));
        assert.ok(html.includes("task-edit__date"));
        assert.ok(html.includes("Adriana"));
        assert.ok(html.includes("2026-08-14"));
    });

    test("el campo hijo/a es un <select>, no texto libre", function () {
        var html = schoolTaskEditHtml({ id: "1", text: "Tarea", child: "Adriana", dueDate: "" });
        assert.ok(html.includes('<select class="task-edit__child"'));
    });
});

describe("schoolChildOptionsHtml", function () {
    test("incluye los tres hijos/as", function () {
        var html = schoolChildOptionsHtml("");
        SCHOOL_CHILDREN.forEach(function (name) {
            assert.ok(html.includes(">" + name + "<"));
        });
    });

    test("marca como seleccionado el hijo/a indicado", function () {
        var html = schoolChildOptionsHtml("Danna");
        assert.ok(html.includes('value="Danna" selected'));
    });

    test("la selección no distingue mayúsculas/espacios", function () {
        var html = schoolChildOptionsHtml("  adriana  ");
        assert.ok(html.includes('value="Adriana" selected'));
    });

    test("sin selección, ninguna opción queda marcada", function () {
        var html = schoolChildOptionsHtml("");
        assert.ok(!html.includes("selected"));
    });

    test("un valor guardado que no coincide se agrega como opción extra", function () {
        var html = schoolChildOptionsHtml("Otro Nombre");
        assert.ok(html.includes('value="Otro Nombre" selected'));
        // Sigue mostrando los tres nombres fijos, sin marcar ninguno.
        SCHOOL_CHILDREN.forEach(function (name) {
            assert.ok(html.includes(">" + name + "<"));
        });
    });
});
