(function initRender(root, factory) {
  const format = typeof require === "function" ? require("./format") : root.WatchdogFormat;
  const api = factory(format);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.WatchdogRender = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRenderApi(format) {
  "use strict";

  function renderSummary(snapshot) {
    const summary = format.summarize(snapshot);
    return [
      summaryItem("Total scanned", summary.scanned),
      summaryItem("Visible", summary.visible),
      summaryItem("Hidden", summary.hidden),
      summaryItem("Reachable HTTP", summary.reachable),
      summaryItem("Network-exposed", summary.networkExposed, summary.networkExposed > 0 ? "warn" : ""),
      summaryItem("Unknown", summary.unknown, summary.unknown > 0 ? "muted" : "")
    ].join("");
  }

  function renderDevRoots(devRoots) {
    if (!devRoots || devRoots.length === 0) {
      return "<div class=\"dev-root-panel muted\"><span class=\"field-label\">Project search boundaries</span>No configured dev roots are active.</div>";
    }

    return `<div class="dev-root-panel">
      <span class="field-label">Project search boundaries</span>
      ${devRoots.map((root) => `<code>${escapeHtml(root)}</code>`).join("")}
    </div>`;
  }

  function renderHistoryStatus(history) {
    const status = history || {};
    const enabled = status.enabled === false ? "disabled" : "enabled";
    const warning = status.warning ? `<span class="history-warning">${escapeHtml(status.warning)}</span>` : "";
    return `<div class="history-panel ${escapeAttr(status.storageHealth || "unknown")}">
      <span class="field-label">History status</span>
      <span>History <strong>${escapeHtml(enabled)}</strong></span>
      <span>Storage <strong>${escapeHtml(status.storageHealth || "unknown")}</strong></span>
      <span>Snapshots <strong>${escapeHtml(status.retainedSnapshotCount || 0)}</strong></span>
      <span>Oldest <strong>${escapeHtml(status.oldestRetainedSnapshot || "n/a")}</strong></span>
      <span>Last write <strong>${escapeHtml(status.lastSuccessfulHistoryWrite || "n/a")}</strong></span>
      <span>Privacy <strong>${escapeHtml(status.redactionPrivacyStatus || "privacy-safe normalized fields only")}</strong></span>
      ${warning}
    </div>`;
  }

  function renderDiagnostics(diagnostics) {
    if (!diagnostics) {
      return "<div class=\"diagnostics-panel muted\"><span class=\"field-label\">Diagnostics</span>Diagnostics unavailable.</div>";
    }

    const sections = [
      diagnosticSection("System", diagnostics.status || "unknown", [
        ["Generated", diagnostics.generatedAt || "n/a"],
        ["Destructive actions", diagnostics.destructiveActionsAvailable ? "available" : "disabled"]
      ]),
      diagnosticSection("Scanner", diagnostics.scanner && diagnostics.scanner.status, [
        ["Active source", diagnostics.scanner && diagnostics.scanner.activeScannerSource || "n/a"],
        ["PowerShell", diagnostics.scanner && diagnostics.scanner.powerShellAvailability || "n/a"],
        ["Get-NetTCPConnection", diagnostics.scanner && diagnostics.scanner.getNetTcpConnectionAvailability || "n/a"],
        ["Get-CimInstance", diagnostics.scanner && diagnostics.scanner.getCimInstanceAvailability || "n/a"],
        ["netstat fallback", diagnostics.scanner && diagnostics.scanner.netstatFallbackAvailability || "n/a"],
        ["Last scan", diagnostics.scanner && diagnostics.scanner.lastScanId || "n/a"],
        ["Duration", diagnostics.scanner && diagnostics.scanner.scanDurationMs != null ? `${diagnostics.scanner.scanDurationMs} ms` : "n/a"],
        ["Warnings", diagnostics.scanner && diagnostics.scanner.scannerWarnings ? diagnostics.scanner.scannerWarnings.join(", ") || "none" : "n/a"],
        ["Recoverable errors", diagnostics.scanner && diagnostics.scanner.recoverableErrors ? diagnostics.scanner.recoverableErrors.map((error) => error.code || error.category || "recoverable").join(", ") || "none" : "n/a"]
      ]),
      diagnosticDevRoots(diagnostics.configuration && diagnostics.configuration.devRoots),
      diagnosticSection("Probing", diagnostics.probing && diagnostics.probing.status, [
        ["Enabled", diagnostics.probing && diagnostics.probing.enabled ? "enabled" : "disabled"],
        ["Timeout", diagnostics.probing ? `${diagnostics.probing.timeoutMs} ms` : "n/a"],
        ["Redirect limit", diagnostics.probing && diagnostics.probing.redirectLimit],
        ["Body metadata cap", diagnostics.probing && diagnostics.probing.responseBodyMetadataCapBytes],
        ["Redirect policy", diagnostics.probing && diagnostics.probing.localhostOnlyRedirectPolicy || "n/a"]
      ]),
      diagnosticSection("Process Context", diagnostics.processContext && diagnostics.processContext.status, [
        ["Project ownership", diagnostics.processContext && diagnostics.processContext.projectOwnership ? diagnostics.processContext.projectOwnership.status : "n/a"],
        ["Launcher context", diagnostics.processContext && diagnostics.processContext.launcherContext ? diagnostics.processContext.launcherContext.status : "n/a"],
        ["Tree max depth", diagnostics.processContext && diagnostics.processContext.maxProcessTreeDepth],
        ["Truncated trees", diagnostics.processContext && diagnostics.processContext.truncatedTreeCount],
        ["Missing parent metadata", diagnostics.processContext && diagnostics.processContext.missingParentMetadataCount],
        ["Missing creation time", diagnostics.processContext && diagnostics.processContext.missingCreationTimeCount]
      ]),
      diagnosticSection("Lifecycle", diagnostics.lifecycle && diagnostics.lifecycle.status, [
        ["Long-running threshold", diagnostics.lifecycle && diagnostics.lifecycle.thresholds ? diagnostics.lifecycle.thresholds.longRunningDevServerMs : "n/a"],
        ["Stale score threshold", diagnostics.lifecycle && diagnostics.lifecycle.thresholds ? diagnostics.lifecycle.thresholds.staleCandidateMinimumScore : "n/a"],
        ["Labels", diagnostics.lifecycle && diagnostics.lifecycle.labels ? diagnostics.lifecycle.labels.join(", ") : "n/a"],
        ["Safety", diagnostics.lifecycle && diagnostics.lifecycle.staleWarning || "n/a"]
      ]),
      diagnosticSection("History", diagnostics.history && diagnostics.history.status, [
        ["Enabled", diagnostics.history && diagnostics.history.enabled ? "enabled" : "disabled"],
        ["Storage", diagnostics.history && diagnostics.history.storageHealth || "n/a"],
        ["Location", diagnostics.history && diagnostics.history.safeDisplayLocation || "n/a"],
        ["Schema", diagnostics.history && diagnostics.history.schemaVersion || "n/a"],
        ["Snapshots", diagnostics.history && diagnostics.history.retainedSnapshotCount],
        ["Processes", diagnostics.history && diagnostics.history.retainedProcessCount],
        ["Oldest", diagnostics.history && diagnostics.history.oldestSnapshot || "n/a"],
        ["Newest", diagnostics.history && diagnostics.history.newestSnapshot || "n/a"],
        ["Last write", diagnostics.history && diagnostics.history.lastSuccessfulWrite || "n/a"],
        ["Warning", diagnostics.history && diagnostics.history.lastWarningOrError || "none"]
      ]),
      diagnosticSection("Privacy and Safety", diagnostics.privacy && diagnostics.privacy.status, [
        ["Command-line redaction", diagnostics.privacy && diagnostics.privacy.commandLineRedactionActive ? "active" : "inactive"],
        ["Path redaction", diagnostics.privacy && diagnostics.privacy.pathRedactionActive ? "active" : "inactive"],
        ["HTTP body persistence", diagnostics.privacy && diagnostics.privacy.httpBodyPersistenceDisabled ? "disabled" : "enabled"],
        ["Raw CIM persistence", diagnostics.privacy && diagnostics.privacy.rawCimPersistenceDisabled ? "disabled" : "enabled"],
        ["Process-tree persistence", diagnostics.privacy && diagnostics.privacy.processTreePersistenceDisabled ? "disabled" : "enabled"],
        ["Protected details", diagnostics.privacy && diagnostics.privacy.protectedDetailsAggregationActive ? "aggregate only" : "unknown"],
        ["History ignored by Git", diagnostics.privacy && diagnostics.privacy.historyFileIgnoredByGit ? "yes" : "warning"]
      ])
    ];

    return `<div class="diagnostics-panel">
      <div class="diagnostics-header">
        <span class="field-label">Configuration and Diagnostics</span>
        <strong>Status ${escapeHtml(diagnostics.status || "unknown")}</strong>
      </div>
      <div class="diagnostics-grid">${sections.join("")}</div>
    </div>`;
  }

  function diagnosticDevRoots(devRoots) {
    const roots = devRoots || {};
    const ignored = roots.ignoredRoots || [];
    const valid = roots.validRoots || [];
    return `<section class="diagnostic-section ${escapeAttr(roots.status || "unknown")}">
      <h3>Dev Roots <span>${escapeHtml(roots.status || "unknown")}</span></h3>
      <dl>
        <dt>Valid roots</dt><dd>${escapeHtml(valid.length)}</dd>
        <dt>Ignored roots</dt><dd>${escapeHtml(ignored.length)}</dd>
        <dt>Effective</dt><dd>${escapeHtml((roots.effectiveValue || []).join(", ") || "none")}</dd>
      </dl>
      ${ignored.length ? `<ul>${ignored.map((root) => `<li>${escapeHtml(root.safeDisplayPath || "n/a")}: ${escapeHtml(root.reasonIgnored || "ignored")}</li>`).join("")}</ul>` : ""}
    </section>`;
  }

  function diagnosticSection(title, status, rows) {
    return `<section class="diagnostic-section ${escapeAttr(status || "unknown")}">
      <h3>${escapeHtml(title)} <span>${escapeHtml(status || "unknown")}</span></h3>
      <dl>
        ${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value == null ? "n/a" : value)}</dd>`).join("")}
      </dl>
    </section>`;
  }

  function filterAndSortServers(servers, options = {}) {
    const filter = options.filter || "all";
    const sort = options.sort || "port";
    return [...(servers || [])]
      .filter((record) => format.matchesFilter(record, filter))
      .sort((a, b) => format.compareRecords(a, b, sort));
  }

  function renderServerList(servers, options = {}) {
    const filtered = filterAndSortServers(servers, options);

    if (filtered.length === 0) {
      return "<div class=\"empty\">No visible listeners match this filter.</div>";
    }

    return `<div class="server-list-inner" role="list">${filtered.map((record) => renderServer(record, options)).join("")}</div>`;
  }

  function renderServer(record, options = {}) {
    const stateName = format.safetyState(record);
    const probe = record.httpProbe || { attempted: false };
    const title = probe.title || record.projectName || record.processName || `Port ${record.port}`;
    const hints = probe.hints || [];
    const project = record.project || null;

    const label = serverAccessibleLabel(record, title);

    return `<article class="server-card ${escapeAttr(stateName)}" role="listitem" aria-label="${escapeAttr(label)}" data-category="${escapeAttr(record.category || "unknown")}" data-port="${escapeAttr(record.port || "")}">
      <div class="card-main">
        <div>
          <div class="title-row">
            <h2>${escapeHtml(title)}</h2>
            <span class="badge ${escapeAttr(record.confidenceLevel || "low")}">${escapeHtml(format.formatConfidence(record))}</span>
            <span class="badge state">${escapeHtml(format.safetyLabel(record))}</span>
          </div>
          <div class="meta-row">
            <span>Port <strong>${escapeHtml(record.port)}</strong></span>
            <span>Host <strong>${escapeHtml(record.host || "n/a")}</strong></span>
            <span>Process <strong>${escapeHtml(record.processName || "unknown")}</strong></span>
            <span>Category <strong>${escapeHtml(record.category || "unknown")}</strong></span>
          </div>
        </div>
        <div class="url-actions">
          ${record.url ? `<a href="${escapeAttr(record.url)}" target="_blank" rel="noreferrer" aria-label="${escapeAttr(`Open ${title} on port ${record.port}`)}">Open ${escapeHtml(record.port)}</a>` : ""}
        </div>
      </div>

      ${renderNetworkExposure(record)}
      ${renderActionEligibility(record, options.dryRuns && options.dryRuns[record.listenerId], options.confirmations && options.confirmations[record.listenerId])}
      ${renderProject(project)}
      ${renderLauncher(record.launcher)}
      ${renderProcessTree(record.processTree)}
      ${renderLifecycle(record.lifecycleContext)}
      ${renderHistoryContext(record.historyContext)}
      ${renderProbe(probe)}

      <div class="details-grid">
        <div>
          <span class="field-label">Project</span>
          <span>${escapeHtml(project && project.name ? project.name : "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Project root</span>
          <code>${escapeHtml(project && project.root ? project.root : "n/a")}</code>
        </div>
        <div>
          <span class="field-label">URL</span>
          <code>${escapeHtml(record.url || "n/a")}</code>
        </div>
        <div>
          <span class="field-label">Final URL</span>
          <code>${escapeHtml(probe.finalUrl || "n/a")}</code>
        </div>
        <div>
          <span class="field-label">Content type</span>
          <span>${escapeHtml(probe.contentType || "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Page title hint</span>
          <span>${escapeHtml(probe.title || "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Launcher</span>
          <span>${escapeHtml(launcherSummary(record.launcher))}</span>
        </div>
        <div>
          <span class="field-label">Parent process</span>
          <span>${escapeHtml(record.launcher && record.launcher.parentProcessName ? record.launcher.parentProcessName : "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Process chain</span>
          <span>${escapeHtml(processTreeSummary(record.processTree))}</span>
        </div>
        <div>
          <span class="field-label">Started</span>
          <span>${escapeHtml(record.createdAt || "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Running duration</span>
          <span>${escapeHtml(record.ageLabel || "unknown age")}</span>
        </div>
        <div>
          <span class="field-label">First seen</span>
          <span>${escapeHtml(record.historyContext && record.historyContext.firstSeenAt ? record.historyContext.firstSeenAt : "n/a")}</span>
        </div>
        <div>
          <span class="field-label">Last seen</span>
          <span>${escapeHtml(record.historyContext && record.historyContext.lastSeenAt ? record.historyContext.lastSeenAt : "n/a")}</span>
        </div>
      </div>

      <div class="hint-row">
        <span class="field-label">Framework/server hints</span>
        ${hints.length ? hints.map((hint) => `<span class="hint">${escapeHtml(hint)}</span>`).join("") : "<span class=\"muted\">No hints</span>"}
      </div>

      <details>
        <summary aria-label="${escapeAttr(`Show evidence and redacted process details for ${title} on port ${record.port}`)}">Evidence and redacted process details</summary>
        <ul class="evidence-list">
          ${(record.evidence || []).map((item) => `<li><span>${escapeHtml(item.type || "evidence")}</span><strong>${escapeHtml(scoreText(item.score))}</strong>${escapeHtml(item.message || "")}</li>`).join("")}
        </ul>
        <div class="command-block">
          <span class="field-label">Redacted command line</span>
          <code>${escapeHtml(record.commandLine || "n/a")}</code>
        </div>
        <div class="command-block">
          <span class="field-label">Redacted parent command line</span>
          <code>${escapeHtml(record.launcher && record.launcher.parentCommandLine ? record.launcher.parentCommandLine : "n/a")}</code>
        </div>
        ${renderProcessTreeDetails(record.processTree)}
        ${renderLifecycleDetails(record.lifecycleContext)}
        ${renderHistoryDetails(record.historyContext)}
        ${renderActionEligibilityDetails(record.actionEligibility, options.dryRuns && options.dryRuns[record.listenerId])}
      </details>
    </article>`;
  }

  function renderActionEligibility(record, dryRun, confirmation) {
    const eligibility = record.actionEligibility || {};
    const dryRunState = dryRun && dryRun.status ? dryRun.status : null;
    const hasPassed = dryRun && dryRun.passed;
    const hasBlockers = dryRun && dryRun.blockers && dryRun.blockers.length;
    const status = dryRunState || eligibility.state || "inspect-only";
    const statusLabel = actionStatusLabel(status, dryRun, eligibility);
    const button = eligibility.canDryRun
      ? `<button type="button" class="dry-run-button" data-dry-run-listener-id="${escapeAttr(record.listenerId || "")}" aria-label="${escapeAttr(`Run read-only safety check for ${record.processName || "listener"} on port ${record.port}`)}"${dryRunState === "evaluating" ? " disabled" : ""}>Run safety check</button>`
      : "";
    const confirmationUi = renderConfirmationIntent(record, dryRun, confirmation);
    const modifier = hasPassed ? "passed" : hasBlockers ? "blocked" : escapeAttr(status);
    return `<div class="action-eligibility-row ${modifier}" role="status" aria-live="polite">
      <span class="field-label">Read-only action readiness</span>
      <span><strong>${escapeHtml(statusLabel)}</strong></span>
      <span>${escapeHtml(dryRun && dryRun.safeMessage ? dryRun.safeMessage : eligibility.safeMessage || "Inspect-only record.")}</span>
      <span>Permission <strong>not granted</strong></span>
      ${button}
      ${confirmationUi}
    </div>`;
  }

  function renderConfirmationIntent(record, dryRun, confirmation) {
    if (!dryRun || !dryRun.passed) return "";
    const state = confirmation && confirmation.state;
    if (!confirmation) {
      return `<div class="confirmation-panel pending">
        <span class="field-label">Confirmation intent</span>
        <span>This records confirmation only. It will not stop, restart, kill, clean up, or signal any process.</span>
        <button type="button" data-confirmation-listener-id="${escapeAttr(record.listenerId || "")}" aria-label="${escapeAttr(`Generate confirmation review for ${record.processName || "listener"} on port ${record.port}`)}">Generate confirmation review</button>
      </div>`;
    }
    if (state === "awaiting-confirmation") {
      const phrase = confirmation.displayChallenge && confirmation.displayChallenge.requiredPhrase || "";
      const owner = confirmation.review && confirmation.review.ownerSessionPolicy || "unknown";
      const elevation = confirmation.review && confirmation.review.elevationPolicy || "unknown";
      return `<div class="confirmation-panel awaiting">
        <span class="field-label">Confirmation intent</span>
        <span>Owner/session <strong>${escapeHtml(owner)}</strong></span>
        <span>Elevation <strong>${escapeHtml(elevation)}</strong></span>
        <span>Type <code>${escapeHtml(phrase)}</code> to record confirmation. No process action will execute.</span>
        <label class="confirmation-label">Confirmation phrase
          <input type="text" autocomplete="off" spellcheck="false" data-confirmation-phrase-input="${escapeAttr(record.listenerId || "")}" aria-label="${escapeAttr(`Confirmation phrase for port ${record.port}`)}">
        </label>
        <button type="button" data-confirmation-submit-listener-id="${escapeAttr(record.listenerId || "")}" aria-label="${escapeAttr(`Record confirmation for ${record.processName || "listener"} on port ${record.port}`)}">Record confirmation</button>
        <button type="button" data-confirmation-cancel-listener-id="${escapeAttr(record.listenerId || "")}" aria-label="${escapeAttr(`Cancel confirmation for ${record.processName || "listener"} on port ${record.port}`)}">Cancel confirmation</button>
      </div>`;
    }
    if (state === "confirmation-accepted") {
      return `<div class="confirmation-panel accepted">
        <span class="field-label">Confirmation intent</span>
        <strong>Confirmation recorded</strong>
        <span>${escapeHtml(confirmation.message || "Confirmation recorded. No process action was executed.")}</span>
      </div>`;
    }
    if (state === "loading" || state === "recording") {
      return `<div class="confirmation-panel pending">
        <span class="field-label">Confirmation intent</span>
        <span>${escapeHtml(confirmation.message || "Confirmation is being processed. No process action will execute.")}</span>
      </div>`;
    }
    return `<div class="confirmation-panel blocked">
      <span class="field-label">Confirmation intent</span>
      <strong>${escapeHtml(confirmationStateLabel(state))}</strong>
      <span>${escapeHtml(confirmation.message || "Confirmation was not recorded. No process action was executed.")}</span>
    </div>`;
  }

  function confirmationStateLabel(state) {
    if (state === "confirmation-input-invalid") return "Phrase mismatch";
    if (state === "confirmation-expired") return "Confirmation expired";
    if (state === "dry-run-expired") return "Dry run expired";
    if (state === "identity-changed") return "Identity changed";
    if (state === "session-invalid") return "Session invalid";
    if (state === "csrf-blocked") return "CSRF blocked";
    if (state === "owner-blocked") return "Owner/session blocked";
    if (state === "elevation-blocked") return "Elevation blocked";
    if (state === "audit-unavailable") return "Audit unavailable";
    if (state === "cancelled") return "Cancelled";
    return "Confirmation unavailable";
  }

  function renderActionEligibilityDetails(eligibility, dryRun) {
    const source = dryRun && dryRun.checks ? dryRun : eligibility || {};
    const checks = source.checks || [];
    return `<div class="action-eligibility-details">
      <span class="field-label">Read-only eligibility checks</span>
      <ul class="evidence-list">
        ${checks.length ? checks.map((item) => `<li><span>${escapeHtml(item.code || "check")}</span><strong>${escapeHtml(item.status || "unknown")}</strong>${escapeHtml(item.message || "")}</li>`).join("") : "<li><span>eligibility</span><strong>unknown</strong>No eligibility checks available.</li>"}
      </ul>
    </div>`;
  }

  function actionStatusLabel(status, dryRun, eligibility) {
    if (dryRun && dryRun.status === "evaluating") return "Evaluating";
    if (dryRun && dryRun.status === "expired") return "Expired";
    if (dryRun && dryRun.blockers && dryRun.blockers.some((item) => item.code === "SCANNER_UNAVAILABLE")) return "Scanner unavailable";
    if (dryRun && dryRun.blockers && dryRun.blockers.some((item) => item.code === "CREATION_TIME_MATCH" || item.code === "LISTENER_ID_MATCH")) return "Identity changed";
    if (dryRun && dryRun.passed && dryRun.warnings && dryRun.warnings.length) return "Safety check complete with warnings";
    if (dryRun && dryRun.passed) return "Safety check complete";
    if (dryRun && dryRun.blockers && dryRun.blockers.length) return "Blocked";
    if (status === "dry-run-eligible") return "Safety check available";
    if (status === "inspect-only") return "Inspect-only";
    if (status === "ineligible") return "Ineligible";
    if (status === "confirmation-eligible") return "Safety check complete";
    if (eligibility && eligibility.canDryRun) return "Safety check available";
    return "Read-only";
  }

  function renderProbe(probe) {
    const reachableClass = probe.reachable ? "ok" : probe.attempted ? "bad" : "muted";
    const label = format.httpProbeLabel(probe);
    return `<div class="probe-row ${reachableClass}" aria-label="${escapeAttr(`HTTP probe status: ${label}`)}">
      <span class="field-label">HTTP probe</span>
      <span class="status-text">${escapeHtml(label)}</span>
      <span>Status <strong>${escapeHtml(probe.statusCode || "n/a")}</strong></span>
      <span>Response <strong>${escapeHtml(format.formatMs(probe.responseTimeMs))}</strong></span>
      ${probe.error ? `<span class="probe-error">${escapeHtml(probe.error)}</span>` : ""}
    </div>`;
  }

  function renderProject(project) {
    if (!project) {
      return "<div class=\"project-row muted\"><span class=\"field-label\">Project ownership</span>No project ownership detected.</div>";
    }

    return `<div class="project-row">
      <span class="field-label">Project ownership</span>
      <span><strong>${escapeHtml(project.name || "Unnamed project")}</strong></span>
      <span>Confidence <strong>${escapeHtml(project.confidence || 0)}</strong></span>
      <span>Source <strong>${escapeHtml(project.source || "unknown")}</strong></span>
    </div>`;
  }

  function renderLauncher(launcher) {
    const summary = launcherSummary(launcher);
    const category = launcher && launcher.parentCategory ? launcher.parentCategory : "missing";
    const processName = launcher && launcher.parentProcessName ? launcher.parentProcessName : "unknown";
    const parentPid = launcher && launcher.parentPid != null ? launcher.parentPid : "n/a";

    return `<div class="launcher-row ${escapeAttr(category)}">
      <span class="field-label">Launcher context</span>
      <span><strong>${escapeHtml(summary)}</strong></span>
      <span>Parent <strong>${escapeHtml(processName)}</strong></span>
      <span>PID <strong>${escapeHtml(parentPid)}</strong></span>
    </div>`;
  }

  function launcherSummary(launcher) {
    if (!launcher || launcher.parentCategory === "missing") return "Parent process unknown";
    if (launcher.launcherName && launcher.parentCategory !== "unknown") return `Launched from ${launcher.launcherName}`;
    return "Parent process unknown";
  }

  function renderProcessTree(processTree) {
    const summary = processTreeSummary(processTree);
    const truncated = processTree && processTree.truncated ? "Truncated" : "Complete";
    const stopReason = processTree && processTree.stopReason ? processTree.stopReason : "n/a";

    return `<div class="process-tree-row ${processTree && processTree.truncated ? "truncated" : ""}">
      <span class="field-label">Process chain</span>
      <span><strong>${escapeHtml(summary)}</strong></span>
      <span>Depth <strong>${escapeHtml(processTree && processTree.depth != null ? processTree.depth : "n/a")}</strong></span>
      <span>${escapeHtml(truncated)}</span>
      <span>Stop <strong>${escapeHtml(stopReason)}</strong></span>
    </div>`;
  }

  function renderProcessTreeDetails(processTree) {
    const chain = processTree && Array.isArray(processTree.chain) ? processTree.chain : [];
    if (chain.length === 0) {
      return `<div class="command-block">
        <span class="field-label">Redacted process tree</span>
        <span class="muted">Parent chain unavailable</span>
      </div>`;
    }

    return `<div class="process-tree-details">
      <span class="field-label">Redacted process tree</span>
      <ol>
        ${chain.map((item) => `<li>
          <span><strong>${escapeHtml(item.launcherName || item.processName || "unknown")}</strong> ${escapeHtml(item.processName || "unknown")} PID ${escapeHtml(item.pid != null ? item.pid : "n/a")} ${escapeHtml(item.category || "unknown")}</span>
          <code>${escapeHtml(item.commandLine || "n/a")}</code>
          <code>${escapeHtml(item.executablePath || "n/a")}</code>
        </li>`).join("")}
      </ol>
    </div>`;
  }

  function renderLifecycle(lifecycle) {
    const label = lifecycle && lifecycle.label ? lifecycle.label : "unknown";
    const staleText = label === "stale-candidate"
      ? "Cautious stale-candidate heuristic. Informational only; not permission to stop this process."
      : label === "possibly-detached"
        ? "Possibly detached heuristic. Informational only; verify manually before any later action phase."
        : "Informational lifecycle context only; no stop or cleanup permission is granted.";

    return `<div class="lifecycle-row ${escapeAttr(label)}">
      <span class="field-label">Lifecycle context</span>
      <span><strong>${escapeHtml(label)}</strong></span>
      <span>Age <strong>${escapeHtml(lifecycle && lifecycle.processAge ? lifecycle.processAge.label : "unknown age")}</strong></span>
      <span>${escapeHtml(staleText)}</span>
    </div>`;
  }

  function renderLifecycleDetails(lifecycle) {
    if (!lifecycle) {
      return `<div class="command-block">
        <span class="field-label">Lifecycle signals</span>
        <span class="muted">Lifecycle context unavailable.</span>
      </div>`;
    }

    const signals = lifecycle.signals || [];
    const limitations = lifecycle.limitations || [];
    return `<div class="lifecycle-details">
      <span class="field-label">Lifecycle signals</span>
      <ul class="evidence-list">
        <li><span>lifecycle</span><strong>${escapeHtml(lifecycle.staleScore || 0)}</strong>${escapeHtml(`label ${lifecycle.label}; detached ${Boolean(lifecycle.detachedCandidate)}; stale ${Boolean(lifecycle.staleCandidate)}`)}</li>
        ${signals.map((signal) => `<li><span>${escapeHtml(signal.type || "signal")}</span><strong>${escapeHtml(scoreText(signal.score))}</strong>${escapeHtml(signal.message || "")}</li>`).join("")}
        ${limitations.map((item) => `<li><span>limitation</span><strong>0</strong>${escapeHtml(item)}</li>`).join("")}
      </ul>
    </div>`;
  }

  function renderHistoryContext(history) {
    if (!history) {
      return `<div class="history-row unknown">
        <span class="field-label">History context</span>
        <span><strong>Unavailable</strong></span>
      </div>`;
    }
    const continuous = history.consecutiveSeenCount > 1 ? "Continuously observed" : "Not yet continuous";
    const reappeared = history.reappeared ? "Reappeared after absence" : "No reappearance detected";
    return `<div class="history-row ${escapeAttr(history.historyStatus || "unknown")}">
      <span class="field-label">History context</span>
      <span><strong>${escapeHtml(history.persistedAcrossScans ? "Repeatedly seen" : "Current scan only")}</strong></span>
      <span>Scans <strong>${escapeHtml(history.seenCount || 0)}</strong></span>
      <span>${escapeHtml(continuous)}</span>
      <span>${escapeHtml(reappeared)}</span>
      <span>Status <strong>${escapeHtml(history.historyStatus || "unknown")}</strong></span>
    </div>`;
  }

  function renderHistoryDetails(history) {
    const evidence = history && history.evidence ? history.evidence : [];
    return `<div class="history-details">
      <span class="field-label">History evidence</span>
      <ul class="evidence-list">
        ${evidence.length ? evidence.map((item) => `<li><span>${escapeHtml(item.type || "history")}</span><strong>${escapeHtml(scoreText(item.score))}</strong>${escapeHtml(item.message || "")}</li>`).join("") : "<li><span>history</span><strong>0</strong>No history evidence available.</li>"}
      </ul>
    </div>`;
  }

  function processTreeSummary(processTree) {
    const chain = processTree && Array.isArray(processTree.chain) ? processTree.chain : [];
    if (chain.length === 0) return "Parent chain unavailable";
    const labels = chain.map((item) => item.launcherName || item.processName || "unknown").filter(Boolean);
    if (labels.length <= 1) return "Parent chain unavailable";
    return labels.join(" -> ");
  }

  function renderNetworkExposure(record) {
    const exposure = record.networkExposure || {};
    if (!exposure.warning) {
      return `<div class="notice safe" aria-label="Network exposure: loopback only">${escapeHtml(exposure.message || "Loopback listener.")}</div>`;
    }
    return `<div class="notice warning" role="note" aria-label="Network exposure warning">${escapeHtml(exposure.message || "Network exposure warning.")}</div>`;
  }

  function renderLoadingState() {
    return "<div class=\"empty loading\" role=\"status\" aria-live=\"polite\">Scanning visible localhost listeners...</div>";
  }

  function renderErrorState(message) {
    return `<div class="empty error" role="alert">Scanner request failed: ${escapeHtml(message || "Unknown error")}</div>`;
  }

  function summaryItem(label, value, modifier = "") {
    return `<div class="summary-item ${escapeAttr(modifier)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function scoreText(score) {
    const number = Number(score);
    if (!Number.isFinite(number)) return "";
    return number > 0 ? `+${number}` : String(number);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function serverAccessibleLabel(record, title) {
    return [
      title,
      `port ${record.port}`,
      record.category || "unknown category",
      format.safetyLabel(record),
      format.httpProbeLabel(record.httpProbe)
    ].filter(Boolean).join(", ");
  }

  return {
    escapeHtml,
    filterAndSortServers,
    renderErrorState,
    renderDevRoots,
    renderDiagnostics,
    renderHistoryStatus,
    renderLoadingState,
    renderActionEligibility,
    renderActionEligibilityDetails,
    renderLauncher,
    renderLifecycle,
    renderProcessTree,
    renderProject,
    renderServer,
    renderServerList,
    renderSummary,
    serverAccessibleLabel
  };
});
