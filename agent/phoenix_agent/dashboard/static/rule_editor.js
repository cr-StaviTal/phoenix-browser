/* Rule Editor - Dynamic form logic for Phoenix EDR */
(function () {
    "use strict";

    var conditionIndex = 0;
    var actionIndex = 0;

    /* ---- Trigger type visibility ---- */
    window.onTriggerTypeChange = function () {
        var type = document.getElementById("trigger-type").value;
        var selectorGroup = document.getElementById("trigger-selector-group");
        var msGroup = document.getElementById("trigger-ms-group");
        var dirGroup = document.getElementById("trigger-direction-group");

        selectorGroup.style.display = "none";
        msGroup.style.display = "none";
        dirGroup.style.display = "none";

        if (["dom_mutation", "form_submit", "click", "input_submit"].indexOf(type) !== -1) {
            selectorGroup.style.display = "";
        }
        if (type === "interval") {
            msGroup.style.display = "";
        }
        if (type === "clipboard") {
            dirGroup.style.display = "";
        }
    };

    /* ---- DOM Conditions ---- */
    window.addCondition = function (data) {
        var idx = conditionIndex++;
        var container = document.getElementById("conditions-list");
        var div = document.createElement("div");
        div.className = "dynamic-item condition-item";
        div.id = "condition-" + idx;
        div.innerHTML =
            '<div class="dynamic-item-header">' +
            '  <span>Condition #' + (idx + 1) + "</span>" +
            '  <button type="button" class="btn btn-small btn-danger" onclick="removeCondition(' + idx + ')">Remove</button>' +
            "</div>" +
            '<div class="form-row">' +
            '  <div class="form-group">' +
            '    <label>Type</label>' +
            '    <select class="cond-type" data-idx="' + idx + '">' +
            '      <option value="element_exists">element_exists</option>' +
            '      <option value="element_absent">element_absent</option>' +
            '      <option value="element_count">element_count</option>' +
            '      <option value="element_text_matches">element_text_matches</option>' +
            '      <option value="element_attr_matches">element_attr_matches</option>' +
            '      <option value="page_text_matches">page_text_matches</option>' +
            "    </select>" +
            "  </div>" +
            '  <div class="form-group">' +
            '    <label>Selector</label>' +
            '    <input type="text" class="cond-selector" placeholder="CSS selector">' +
            "  </div>" +
            '  <div class="form-group">' +
            '    <label>Pattern (regex)</label>' +
            '    <input type="text" class="cond-pattern" placeholder="regex pattern">' +
            "  </div>" +
            "</div>" +
            '<div class="form-row">' +
            '  <div class="form-group">' +
            '    <label>Attribute</label>' +
            '    <input type="text" class="cond-attribute" placeholder="attribute name">' +
            "  </div>" +
            '  <div class="form-group">' +
            '    <label>Operator</label>' +
            '    <select class="cond-operator">' +
            '      <option value="">--</option>' +
            '      <option value="eq">eq</option>' +
            '      <option value="gt">gt</option>' +
            '      <option value="lt">lt</option>' +
            '      <option value="gte">gte</option>' +
            '      <option value="lte">lte</option>' +
            "    </select>" +
            "  </div>" +
            '  <div class="form-group">' +
            '    <label>Value</label>' +
            '    <input type="number" class="cond-value" placeholder="numeric value">' +
            "  </div>" +
            "</div>";
        container.appendChild(div);

        if (data) {
            var el = div;
            el.querySelector(".cond-type").value = data.type || "element_exists";
            el.querySelector(".cond-selector").value = data.selector || "";
            el.querySelector(".cond-pattern").value = data.pattern || "";
            el.querySelector(".cond-attribute").value = data.attribute || "";
            el.querySelector(".cond-operator").value = data.operator || "";
            if (data.value != null) el.querySelector(".cond-value").value = data.value;
        }
    };

    window.removeCondition = function (idx) {
        var el = document.getElementById("condition-" + idx);
        if (el) el.remove();
    };

    /* ---- Actions ---- */
    var actionParamFields = {
        hide_element: ["selector"],
        remove_element: ["selector"],
        highlight_element: ["selector"],
        add_overlay: ["selector", "message", "severity"],
        set_attribute: ["selector", "attribute", "value"],
        add_class: ["selector", "className"],
        block_form_submit: ["selector", "message"],
        block_click: ["selector", "message"],
        block_navigation: ["message"],
        log_event: ["message"],
        alert: ["title", "message"],
        extract_data: ["selector", "attributes", "extract_text"],
        inject_banner: ["message", "position", "severity"],
        inject_tooltip: ["selector", "message"],
        redirect: ["url"],
        close_tab: [],
        notify: ["title", "message"],
    };

    function buildParamsHtml(actionType, params) {
        var fields = actionParamFields[actionType] || [];
        var html = "";
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            var val = params && params[f] != null ? params[f] : "";
            if (f === "extract_text") {
                html +=
                    '<div class="form-group form-group-toggle"><label><input type="checkbox" class="action-param" data-param="' +
                    f + '" ' + (val ? "checked" : "") + '> Extract text</label></div>';
            } else if (f === "position") {
                html +=
                    '<div class="form-group"><label>Position</label><select class="action-param" data-param="position">' +
                    '<option value="top"' + (val === "top" ? " selected" : "") + '>top</option>' +
                    '<option value="bottom"' + (val === "bottom" ? " selected" : "") + '>bottom</option>' +
                    "</select></div>";
            } else if (f === "severity") {
                html +=
                    '<div class="form-group"><label>Severity</label><select class="action-param" data-param="severity">' +
                    '<option value="info"' + (val === "info" ? " selected" : "") + ">info</option>" +
                    '<option value="low"' + (val === "low" ? " selected" : "") + ">low</option>" +
                    '<option value="medium"' + (val === "medium" ? " selected" : "") + ">medium</option>" +
                    '<option value="high"' + (val === "high" ? " selected" : "") + ">high</option>" +
                    '<option value="critical"' + (val === "critical" ? " selected" : "") + ">critical</option>" +
                    "</select></div>";
            } else {
                html +=
                    '<div class="form-group"><label>' + f + '</label><input type="text" class="action-param" data-param="' +
                    f + '" value="' + escapeAttr(String(val)) + '"></div>';
            }
        }
        return html;
    }

    window.addAction = function (data) {
        var idx = actionIndex++;
        var container = document.getElementById("actions-list");
        var div = document.createElement("div");
        div.className = "dynamic-item action-item";
        div.id = "action-" + idx;

        var typeOptions = Object.keys(actionParamFields)
            .map(function (t) {
                var sel = data && data.type === t ? " selected" : "";
                return '<option value="' + t + '"' + sel + ">" + t + "</option>";
            })
            .join("");

        var currentType = data ? data.type : "log_event";
        var paramsHtml = buildParamsHtml(currentType, data ? data.params : {});

        div.innerHTML =
            '<div class="dynamic-item-header">' +
            '  <span>Action #' + (idx + 1) + "</span>" +
            '  <button type="button" class="btn btn-small btn-danger" onclick="removeAction(' + idx + ')">Remove</button>' +
            "</div>" +
            '<div class="form-row">' +
            '  <div class="form-group">' +
            '    <label>Type</label>' +
            '    <select class="action-type" data-idx="' + idx + '" onchange="onActionTypeChange(' + idx + ')">' +
            typeOptions +
            "    </select>" +
            "  </div>" +
            "</div>" +
            '<div class="form-row action-params" id="action-params-' + idx + '">' +
            paramsHtml +
            "</div>";
        container.appendChild(div);
    };

    window.removeAction = function (idx) {
        var el = document.getElementById("action-" + idx);
        if (el) el.remove();
    };

    window.onActionTypeChange = function (idx) {
        var el = document.getElementById("action-" + idx);
        var type = el.querySelector(".action-type").value;
        var paramsDiv = document.getElementById("action-params-" + idx);
        paramsDiv.innerHTML = buildParamsHtml(type, {});
    };

    /* ---- Form Submission ---- */
    function collectFormData() {
        var rule = {};
        rule.name = document.getElementById("rule-name").value.trim();
        rule.description = document.getElementById("rule-description").value.trim();
        rule.severity = document.getElementById("rule-severity").value;
        rule.priority = parseInt(document.getElementById("rule-priority").value, 10) || 100;
        rule.author = document.getElementById("rule-author").value.trim();
        rule.enabled = document.getElementById("rule-enabled").checked;
        rule.run_once_per_page = document.getElementById("rule-run-once").checked;
        rule.cooldown_ms = parseInt(document.getElementById("rule-cooldown").value, 10) || 0;

        var tagsRaw = document.getElementById("rule-tags").value.trim();
        rule.tags = tagsRaw ? tagsRaw.split(",").map(function (t) { return t.trim(); }).filter(Boolean) : [];

        /* Match */
        var match = {};
        var domains = textareaToList("match-domains");
        if (domains.length) match.domains = domains;
        var excludeDomains = textareaToList("match-exclude-domains");
        if (excludeDomains.length) match.exclude_domains = excludeDomains;
        var urlPatterns = textareaToList("match-url-patterns");
        if (urlPatterns.length) match.url_patterns = urlPatterns;

        var trigger = { type: document.getElementById("trigger-type").value };
        var triggerSelector = document.getElementById("trigger-selector").value.trim();
        if (triggerSelector) trigger.selector = triggerSelector;
        var triggerMs = document.getElementById("trigger-ms").value;
        if (trigger.type === "interval" && triggerMs) trigger.ms = parseInt(triggerMs, 10);
        var triggerDir = document.getElementById("trigger-direction").value;
        if (trigger.type === "clipboard") trigger.direction = triggerDir;
        match.trigger = trigger;

        /* DOM Conditions */
        var condItems = document.querySelectorAll(".condition-item");
        if (condItems.length) {
            var conditions = [];
            condItems.forEach(function (item) {
                var cond = {};
                cond.type = item.querySelector(".cond-type").value;
                var s = item.querySelector(".cond-selector").value.trim();
                if (s) cond.selector = s;
                var p = item.querySelector(".cond-pattern").value.trim();
                if (p) cond.pattern = p;
                var a = item.querySelector(".cond-attribute").value.trim();
                if (a) cond.attribute = a;
                var op = item.querySelector(".cond-operator").value;
                if (op) cond.operator = op;
                var v = item.querySelector(".cond-value").value;
                if (v !== "") cond.value = parseInt(v, 10);
                conditions.push(cond);
            });
            match.dom_conditions = conditions;
        }
        rule.match = match;

        /* Actions */
        var actionItems = document.querySelectorAll(".action-item");
        var actions = [];
        actionItems.forEach(function (item) {
            var action = {};
            action.type = item.querySelector(".action-type").value;
            var params = {};
            item.querySelectorAll(".action-param").forEach(function (input) {
                var paramName = input.dataset.param;
                if (input.type === "checkbox") {
                    params[paramName] = input.checked;
                } else {
                    var val = input.value.trim();
                    if (val) {
                        if (paramName === "attributes") {
                            params[paramName] = val.split(",").map(function (s) { return s.trim(); });
                        } else {
                            params[paramName] = val;
                        }
                    }
                }
            });
            action.params = params;
            actions.push(action);
        });
        rule.actions = actions;

        return rule;
    }

    function textareaToList(id) {
        var val = document.getElementById(id).value.trim();
        if (!val) return [];
        return val.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    }

    function escapeAttr(s) {
        return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /* ---- Init ---- */
    function init() {
        /* Set trigger type if editing */
        if (RULE_DATA) {
            var tt = RULE_DATA.match.trigger.type;
            document.getElementById("trigger-type").value = tt;
            if (RULE_DATA.match.trigger.direction) {
                document.getElementById("trigger-direction").value = RULE_DATA.match.trigger.direction;
            }

            /* Load conditions */
            if (RULE_DATA.match.dom_conditions) {
                RULE_DATA.match.dom_conditions.forEach(function (c) {
                    addCondition(c);
                });
            }

            /* Load actions */
            if (RULE_DATA.actions) {
                RULE_DATA.actions.forEach(function (a) {
                    addAction(a);
                });
            }
        } else {
            /* New rule: add one default action */
            addAction({ type: "log_event", params: { message: "" } });
        }

        onTriggerTypeChange();
    }

    /* Form submit handler */
    document.getElementById("rule-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var data = collectFormData();
        if (!data.name) {
            alert("Rule name is required.");
            return;
        }
        if (!data.actions || data.actions.length === 0) {
            alert("At least one action is required.");
            return;
        }

        var ruleId = document.getElementById("rule-id").value;
        var method = ruleId ? "PUT" : "POST";
        var url = ruleId ? "/api/rules/" + ruleId : "/api/rules";

        fetch(url, {
            method: method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        })
            .then(function (r) {
                if (!r.ok) return r.json().then(function (d) { throw new Error(d.detail || "Save failed"); });
                return r.json();
            })
            .then(function () {
                window.location.href = "/dashboard/rules";
            })
            .catch(function (err) {
                alert("Error: " + err.message);
            });
    });

    init();
})();
