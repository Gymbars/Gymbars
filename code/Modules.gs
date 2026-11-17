/**
 * Modules.gs — Acciones del sistema de gestión expuestas al panel (vía gbApi).
 *
 * Api.gs llama a gbModuleActions_ y mezcla este registro con el del sitio web.
 * Cada acción declara qué roles pueden usarla; las funciones son privadas, así que
 * el navegador solo puede llegar a ellas a través de gbApi (que valida el rol).
 *
 *   ADMIN  solo administradores (dinero, bajas, configuración)
 *   ANY    administradores y entrenadores
 */
function gbModuleActions_(ADMIN, ANY) {
  return {
    // --- Miembros ---
    'members.search':       { roles: ANY,   fn: gbMembersSearch_ },
    'members.get':          { roles: ANY,   fn: gbMemberGet_ },
    'members.save':         { roles: ANY,   fn: gbMemberSave_ },
    'members.setStatus':    { roles: ANY,   fn: gbMemberSetStatus_ },
    'members.delete':       { roles: ADMIN, fn: gbMemberDelete_ },

    // --- Pagos (dinero: solo Admin) ---
    'payments.register':    { roles: ADMIN, fn: gbPaymentRegisterApi_ },
    'payments.void':        { roles: ADMIN, fn: gbPaymentVoid_ },

    // --- Medidas y evaluaciones ---
    'measurements.prefill':  { roles: ANY, fn: gbMeasurementPrefill_ },
    'measurements.register': { roles: ANY, fn: gbMeasurementRegister_ },
    'measurements.remove':   { roles: ANY, fn: gbMeasurementRemove_ },
    'evaluations.catalog':   { roles: ANY, fn: gbEvaluationCatalog_ },
    'evaluations.register':  { roles: ANY, fn: gbEvaluationRegister_ },
    'evaluations.remove':    { roles: ANY, fn: gbEvaluationRemove_ },

    // --- Mensajes ---
    'messages.list':         { roles: ANY,   fn: gbMessagesList_ },
    'messages.queue':        { roles: ANY,   fn: gbMessageQueueApi_ },
    'messages.markSent':     { roles: ANY,   fn: gbMessageMarkSent_ },
    'messages.discard':      { roles: ANY,   fn: gbMessageDiscard_ },
    'messages.retryEmail':   { roles: ANY,   fn: gbMessageRetryEmail_ },
    'templates.list':        { roles: ADMIN, fn: gbTemplatesList_ },
    'templates.save':        { roles: ADMIN, fn: gbTemplateSave_ },

    // --- Automatización (recordatorios, inactividad) ---
    'automation.status':     { roles: ADMIN, fn: gbAutomationStatus_ },
    'automation.setEnabled': { roles: ADMIN, fn: gbAutomationSetEnabled_ },
    'automation.install':    { roles: ADMIN, fn: gbInstallTriggersApi_ },
    'automation.run':        { roles: ADMIN, fn: gbAutomationRunApi_ },
    'automation.review':     { roles: ADMIN, fn: gbReviewStates_ },
    'members.bulkStatus':    { roles: ADMIN, fn: gbMembersBulkStatus_ },

    // --- Asistencia y dispositivos (tablet con QR) ---
    'attendance.manual':     { roles: ANY,   fn: gbAttendanceManual_ },
    'attendance.today':      { roles: ANY,   fn: gbAttendanceToday_ },
    'attendance.history':    { roles: ANY,   fn: gbAttendanceHistory_ },
    'attendance.setStart':   { roles: ADMIN, fn: gbAttendanceSetStart_ },
    'devices.list':          { roles: ADMIN, fn: gbDevicesList_ },
    'devices.createPairing': { roles: ADMIN, fn: gbDevicePairingCreate_ },
    'devices.revoke':        { roles: ADMIN, fn: gbDeviceRevoke_ },

    // --- Carnet / pase de Wallet ---
    'wallet.carnet':         { roles: ANY,   fn: gbCarnetInfo_ },
    'wallet.check':          { roles: ADMIN, fn: gbWalletCheck_ },

    // --- Progreso (panorama del día) ---
    'progress.overview':     { roles: ANY,   fn: gbProgressOverview_ },
    'progress.archiveStale': { roles: ADMIN, fn: gbArchiveStale_ },

    // --- Configuración ---
    'config.get':            { roles: ADMIN, fn: gbConfigGetApi_ },
    'config.set':            { roles: ADMIN, fn: gbConfigSetApi_ }
  };
}
