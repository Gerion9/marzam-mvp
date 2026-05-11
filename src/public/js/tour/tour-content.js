/* =============================================================
   Marzam tour content — declarative registry of all guided tours.

   Schema (per tour):
     {
       id, role, title, summary, icon,
       hierarchy: { canAssignTo: [labels], canBeAssignedBy: [labels] },
       prerequisites: { needsAssignment, fallbackToDemo },
       steps: [
         { id, kind, title, body | bodyHtml | bodyComponent,
           target?, placement?, placementMobile?,
           waitForTarget?, requireClick?, onEnter?,
           next: { label, action } }
       ]
     }

   Step kinds:
     - 'modal'       — centered, no spotlight (kind='modal' implies placement='center')
     - 'spotlight'   — clip-out the target rect, position callout near it
     - 'interactive' — like spotlight + requireClick:true (waits for user to click target)

   Helpful selectors found in the live app.html / app.js:
     - '#tour-help-btn'                     — the help (?) button (topbar)
     - '#sidenav [data-tab="routes"]'       — Mis rutas tab
     - '#sidenav [data-tab="team"]'         — Mi equipo tab (managers only)
     - '#sidenav [data-tab="live"]'         — En vivo tab (managers only)
     - '#sidenav [data-tab="analytics"]'    — Analíticas tab
     - '#sidenav [data-tab="plan"]'         — Plan & Metas tab (managers only)
     - '#fab-start-visit'                   — FAB Iniciar Modo Visita (rep, on routes)
     - '#user-menu-btn'                     — avatar
     - '#search-input'                      — global search
     - '#panel'                             — the sliding panel
     - '#topbar'                            — header bar
   ============================================================= */
(function () {
  'use strict';

  const REG = window.TOUR_REGISTRY = window.TOUR_REGISTRY || {};

  // ── Helpers shared across tours ──────────────────────────────
  function selectTab(tabId) {
    return () => {
      try {
        if (window.MarzamApp && typeof window.MarzamApp.selectTab === 'function') {
          window.MarzamApp.selectTab(tabId);
        }
      } catch (e) { /* ignore */ }
    };
  }

  // Common terminal step "Done" — what to say after the last meaningful step.
  function doneStep(roleLabel) {
    return {
      id: 'done',
      kind: 'modal',
      placement: 'center',
      title: '¡Listo, ' + roleLabel + '!',
      body: 'Has completado este capítulo.\n\nPuedes volver al tutorial cuando quieras desde el botón ? en la barra superior, o desde el menú de tu avatar. Cada capítulo está ahí esperándote.',
      next: { label: 'Cerrar' },
    };
  }

  // Common hierarchy step
  function hierarchyStep(intro) {
    return {
      id: 'hierarchy',
      kind: 'modal',
      placement: 'center',
      title: 'Tu lugar en el equipo',
      body: intro || 'Así se acomoda tu nivel dentro de la organización Marzam:',
      bodyComponent: 'hierarchyDiagram',
    };
  }

  // ╔══════════════════════════════════════════════════════════╗
  // ║ REPRESENTANTE                                            ║
  // ╚══════════════════════════════════════════════════════════╝

  REG['representante-onboarding'] = {
    id: 'representante-onboarding',
    role: 'representante',
    title: 'Bienvenida — Representante',
    summary: 'Lo esencial: dónde está tu plan de hoy y cómo capturar visitas en menos de 1 minuto.',
    icon: 'map',
    hierarchy: {
      canAssignTo: [],
      canBeAssignedBy: ['Supervisor', 'Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: true, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Tu día como Representante',
        body: 'En Marzam tu trabajo es visitar farmacias asignadas, dejar evidencia (foto + datos) y reportar el resultado de cada visita.\n\nVamos a recorrer la app paso a paso. Tarda menos de 2 minutos.',
      },
      {
        id: 'tabs', kind: 'spotlight',
        target: '#sidenav [data-tab="routes"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mis rutas',
        body: 'Aquí ves las farmacias asignadas para hoy, ordenadas para que tu recorrido tenga sentido.',
        onEnter: selectTab('routes'),
      },
      {
        id: 'panel', kind: 'spotlight',
        target: '#panel',
        placement: 'right', placementMobile: 'top',
        title: 'Tu lista de paradas',
        body: 'Cada tarjeta es una farmacia. Tap (o click) en una para verla en el mapa y abrir su ficha.\n\nEn móvil puedes arrastrar este panel hacia arriba para ver más detalles.',
      },
      {
        id: 'fab', kind: 'spotlight',
        target: '#fab-start-visit',
        placement: 'top',
        title: 'Iniciar Modo Visita',
        body: 'Cuando llegues a la farmacia, toca este botón para iniciar el cronómetro.\n\nMarzam registra la hora de inicio y tu ubicación GPS para auditoría.',
      },
      {
        id: 'analytics', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Tus analíticas',
        body: 'Aquí ves tu propio rendimiento: cuántas visitas completaste, cobertura de tu zona y tu progreso vs. tus metas.',
        onEnter: selectTab('analytics'),
      },
      hierarchyStep('Como Representante eres quien ejecuta las visitas en campo. Tus jefes son quienes te asignan trabajo:'),
      doneStep('Representante'),
    ],
  };

  REG['representante-capture-visit'] = {
    id: 'representante-capture-visit',
    role: 'representante',
    title: 'Capturar una visita',
    summary: 'Foto, datos y resultado: cómo dejar evidencia válida en cada farmacia.',
    icon: 'camera',
    hierarchy: {
      canAssignTo: [],
      canBeAssignedBy: ['Supervisor', 'Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: true, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Captura una visita',
        body: 'Cada visita necesita una foto válida (la fachada, el contador o el documento) Y un resultado seleccionado. Sin foto, la visita no cuenta para el cobro.',
      },
      {
        id: 'go-routes', kind: 'spotlight',
        target: '#sidenav [data-tab="routes"]',
        placement: 'right', placementMobile: 'top',
        title: 'Ve a Mis rutas',
        body: 'Las visitas siempre se inician desde aquí. Desde otras pantallas no aparece el botón.',
        onEnter: selectTab('routes'),
      },
      {
        id: 'fab2', kind: 'spotlight',
        target: '#fab-start-visit',
        placement: 'top',
        title: 'Iniciar Modo Visita',
        body: 'Toca este botón al llegar. Aparece un cronómetro arriba.\n\nDespués escogerás la farmacia que estás visitando y subirás la foto.',
      },
      {
        id: 'photo', kind: 'modal', placement: 'center',
        title: 'Foto: tu evidencia',
        body: 'Marzam acepta foto desde cámara o galería. Procura:\n\n• Buena luz\n• Que se vea claramente lo que validas (fachada, contador o documento según el resultado)\n• Sin recortes raros',
      },
      {
        id: 'outcome', kind: 'modal', placement: 'center',
        title: 'Selecciona el resultado',
        body: 'Hay 9 resultados posibles. Los más comunes:\n\n• Visita exitosa\n• Sin contacto\n• Necesita seguimiento\n• Cerrada / Movida\n\nElige el que mejor describe lo que pasó. Cada uno tiene consecuencias distintas en el plan.',
      },
      doneStep('Representante'),
    ],
  };

  REG['representante-photo-evidence'] = {
    id: 'representante-photo-evidence',
    role: 'representante',
    title: 'Tips para fotos válidas',
    summary: 'Qué hace que una foto pase la revisión y cobre — y qué la hace rechazarse.',
    icon: 'camera',
    hierarchy: {
      canAssignTo: [],
      canBeAssignedBy: ['Supervisor', 'Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Fotos que sí cuentan',
        body: 'Tus fotos pasan por revisión del Supervisor. Si rechazan la foto, la visita no se cobra.',
      },
      {
        id: 'do', kind: 'modal', placement: 'center',
        title: 'Lo que SÍ debe verse',
        body: '• Fachada de la farmacia con su rótulo\n• El contador o cliente reconocible (si la visita lo requiere)\n• Documentos legibles cuando capturas alta\n• Hora visible si es comprobante',
      },
      {
        id: 'dont', kind: 'modal', placement: 'center',
        title: 'Lo que NO debe pasar',
        body: '• Foto borrosa o muy oscura\n• Foto de una pantalla\n• Foto reciclada de otra visita\n• Foto en la calle sin la farmacia visible',
      },
      doneStep('Representante'),
    ],
  };

  REG['representante-analytics'] = {
    id: 'representante-analytics',
    role: 'representante',
    title: 'Entender tus analíticas',
    summary: 'Cómo leer tus números: cobertura, cumplimiento y meta de visitas.',
    icon: 'analytics',
    hierarchy: {
      canAssignTo: [],
      canBeAssignedBy: ['Supervisor', 'Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Tus analíticas',
        body: 'Toca aquí para abrir el dashboard de Analíticas.',
        onEnter: selectTab('analytics'),
      },
      {
        id: 'panel-detail', kind: 'spotlight',
        target: '#panel',
        placement: 'right', placementMobile: 'top',
        title: 'Tus indicadores',
        body: 'Verás:\n\n• Cobertura: qué porcentaje de tus farmacias asignadas visitaste\n• Cumplimiento: visitas reales vs. meta semanal\n• Tendencia: cómo evolucionas semana a semana',
      },
      doneStep('Representante'),
    ],
  };

  // ╔══════════════════════════════════════════════════════════╗
  // ║ SUPERVISOR                                                ║
  // ╚══════════════════════════════════════════════════════════╝

  REG['supervisor-onboarding'] = {
    id: 'supervisor-onboarding',
    role: 'supervisor',
    title: 'Bienvenida — Supervisor',
    summary: 'Recorrido por las herramientas para coordinar a tu equipo de Representantes.',
    icon: 'team',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Tu día como Supervisor',
        body: 'Eres el puente entre Gerencia y Representantes. Tu trabajo: armar el plan semanal, revisar las visitas que reportan tus reps y reaccionar a alertas en tiempo real.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mi equipo',
        body: 'Aquí ves a tus Representantes, su estado de hoy y puedes entrar al detalle de cada uno.',
        onEnter: selectTab('team'),
      },
      {
        id: 'plan', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas',
        body: 'Aquí armas el plan semanal: qué Representante visita qué farmacias y en qué orden. Marzam optimiza la ruta por ti.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'live', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo',
        body: 'Mapa con la ubicación actual de tus Representantes y su progreso del día. Útil para resolver dudas en tiempo real o detectar reps con problemas.',
        onEnter: selectTab('live'),
      },
      {
        id: 'analytics', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Analíticas',
        body: 'Indicadores agregados de tu equipo: cobertura, cumplimiento, calidad de visitas, fotos rechazadas, etc.',
        onEnter: selectTab('analytics'),
      },
      hierarchyStep('Como Supervisor coordinas a tus Representantes y reportas a tu Gerente:'),
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-team'] = {
    id: 'supervisor-team',
    role: 'supervisor',
    title: 'Conocer a Mi equipo',
    summary: 'Ver el estado de cada Representante y entrar al detalle de su día.',
    icon: 'team',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Abre Mi equipo',
        body: 'Toca aquí.',
        onEnter: selectTab('team'),
      },
      {
        id: 'list', kind: 'spotlight',
        target: '#panel',
        placement: 'right', placementMobile: 'top',
        title: 'Lista de Representantes',
        body: 'Cada tarjeta muestra el rep, su porcentaje de cumplimiento del día y un indicador de estado (en ruta, parado, sin pings, etc.).',
      },
      {
        id: 'drill', kind: 'modal', placement: 'center',
        title: 'Drill-down a un Representante',
        body: 'Click en una tarjeta abre el detalle del rep: sus farmacias asignadas hoy, sus visitas reportadas, su trayecto GPS y sus alertas.',
      },
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-create-plan'] = {
    id: 'supervisor-create-plan',
    role: 'supervisor',
    title: 'Crear el plan semanal',
    summary: 'Generar plan de visitas para tu equipo y publicarlo.',
    icon: 'plan',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas',
        body: 'Toca aquí para entrar al editor de planes.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'editor', kind: 'spotlight',
        target: '#panel',
        placement: 'right', placementMobile: 'top',
        title: 'Editor de plan',
        body: 'Eliges la semana, los Representantes incluidos y las farmacias candidatas. Marzam calcula automáticamente la mejor ruta para cada uno.',
      },
      {
        id: 'preview', kind: 'modal', placement: 'center',
        title: 'Vista previa antes de publicar',
        body: 'Antes de publicar puedes:\n\n• Ver el plan en el mapa\n• Ajustar manualmente paradas\n• Comprobar el costo y kilómetros estimados\n\nNada se asigna a tus reps hasta que toques "Publicar".',
      },
      {
        id: 'publish', kind: 'modal', placement: 'center',
        title: 'Publicar',
        body: 'Al publicar, cada Representante ve su plan al abrir su app. Puedes re-planificar luego si surgen cambios.',
      },
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-assign-reps'] = {
    id: 'supervisor-assign-reps',
    role: 'supervisor',
    title: 'Asignar farmacias a Representantes',
    summary: 'Cómo asignar farmacias específicas a un rep fuera del plan automático.',
    icon: 'assign',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Asignaciones manuales',
        body: 'A veces necesitas que un Representante específico atienda una farmacia específica (porque conoce al cliente, por geografía, etc.). Eso es una asignación manual.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Desde Mi equipo',
        body: 'Entra al detalle del Representante a quien quieres asignar.',
        onEnter: selectTab('team'),
      },
      {
        id: 'pick', kind: 'modal', placement: 'center',
        title: 'Elige la farmacia',
        body: 'En el detalle del rep aparece un buscador de farmacias. Escoge la que quieres asignar y la ventana que aplique. Marzam te avisa si entra en conflicto con su plan actual.',
      },
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-live'] = {
    id: 'supervisor-live',
    role: 'supervisor',
    title: 'Monitorear En vivo',
    summary: 'Ver dónde están tus Representantes ahora mismo y reaccionar a problemas.',
    icon: 'live',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo',
        body: 'Toca aquí para abrir el monitor en tiempo real.',
        onEnter: selectTab('live'),
      },
      {
        id: 'map', kind: 'modal', placement: 'center',
        title: 'Mapa con tus reps',
        body: 'Cada pin es un Representante, con color por estado:\n\n• Verde: en ruta\n• Naranja: parado más de 15 min sin reportar\n• Rojo: sin pings (posible problema de señal o app cerrada)',
      },
      {
        id: 'alert', kind: 'modal', placement: 'center',
        title: 'Alertas',
        body: 'En la barra superior aparece un contador de alertas activas. Toca una alerta para ver detalle y marcarla como atendida.',
      },
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-approve-visits'] = {
    id: 'supervisor-approve-visits',
    role: 'supervisor',
    title: 'Revisar y aprobar visitas',
    summary: 'Las visitas de tus reps necesitan tu aprobación para cobrar.',
    icon: 'review',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Cola de revisión',
        body: 'Las visitas reportadas por tus Representantes pasan a una cola de revisión. Tú las apruebas (cobran) o las rechazas (se les pide repetir o corregir).',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Desde Mi equipo',
        body: 'Entra al detalle de un Representante; ahí ves sus visitas pendientes de revisión.',
        onEnter: selectTab('team'),
      },
      {
        id: 'check', kind: 'modal', placement: 'center',
        title: 'Qué revisar',
        body: 'Verifica:\n\n• Foto válida (clara, contexto correcto)\n• GPS dentro del radio de la farmacia\n• Resultado coherente con la foto\n\nSi todo bien, aprueba. Si no, rechaza con un comentario para el rep.',
      },
      doneStep('Supervisor'),
    ],
  };

  REG['supervisor-analytics'] = {
    id: 'supervisor-analytics',
    role: 'supervisor',
    title: 'Analíticas del equipo',
    summary: 'Lectura rápida de los KPI de tu equipo y dónde enfocar.',
    icon: 'analytics',
    hierarchy: {
      canAssignTo: ['Representante'],
      canBeAssignedBy: ['Gerente', 'Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Analíticas',
        body: 'Toca para abrir el dashboard.',
        onEnter: selectTab('analytics'),
      },
      {
        id: 'reads', kind: 'modal', placement: 'center',
        title: 'Qué leer primero',
        body: 'En orden de prioridad:\n\n1. Cumplimiento del equipo (% visitas vs. meta)\n2. Cobertura territorial\n3. Reps con foto rechazada (calidad)\n4. Tendencia 4 semanas',
      },
      doneStep('Supervisor'),
    ],
  };

  // ╔══════════════════════════════════════════════════════════╗
  // ║ GERENTE_VENTAS                                            ║
  // ╚══════════════════════════════════════════════════════════╝

  REG['gerente_ventas-onboarding'] = {
    id: 'gerente_ventas-onboarding',
    role: 'gerente_ventas',
    title: 'Bienvenida — Gerente',
    summary: 'Vista regional: tus Supervisores y sus Representantes en un solo lugar.',
    icon: 'hierarchy',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Tu rol como Gerente',
        body: 'Coordinas varios Supervisores y, a través de ellos, a sus Representantes. Tu vista es regional: ves a todos en cascada.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mi equipo',
        body: 'Tu equipo es la cascada completa: Supervisores y los Representantes que cuelgan de ellos. Puedes hacer drill-down en cualquiera.',
        onEnter: selectTab('team'),
      },
      {
        id: 'plan', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas',
        body: 'Puedes generar planes regionales que se distribuyen entre tus Supervisores y Representantes. También puedes definir metas por Supervisor.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'live', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo regional',
        body: 'Mapa con todos tus Representantes ubicados en tiempo real. Puedes filtrar por Supervisor.',
        onEnter: selectTab('live'),
      },
      {
        id: 'analytics', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Analíticas regionales',
        body: 'KPI agregados de tu región: cobertura, cumplimiento, calidad, costo por visita. Puedes desglosar por Supervisor.',
        onEnter: selectTab('analytics'),
      },
      hierarchyStep('Como Gerente coordinas a tus Supervisores y Representantes; el Director te asigna metas:'),
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-region'] = {
    id: 'gerente_ventas-region',
    role: 'gerente_ventas',
    title: 'Mi región en detalle',
    summary: 'Cómo navegar la cascada de Supervisores y Representantes.',
    icon: 'team',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mi equipo',
        body: 'Toca aquí.',
        onEnter: selectTab('team'),
      },
      {
        id: 'cascade', kind: 'modal', placement: 'center',
        title: 'Cascada completa',
        body: 'Ves primero la lista de Supervisores. Click en uno te lleva a su equipo de Representantes. Click en un Representante te lleva a su detalle de día.\n\nUsa la flecha "atrás" para regresar al nivel anterior.',
      },
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-create-plan'] = {
    id: 'gerente_ventas-create-plan',
    role: 'gerente_ventas',
    title: 'Crear plan regional',
    summary: 'Generar un plan que se reparte entre tus Supervisores y Representantes.',
    icon: 'plan',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas',
        body: 'Toca aquí.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'scope', kind: 'modal', placement: 'center',
        title: 'Alcance del plan',
        body: 'Defines:\n\n• Semana objetivo\n• Cuáles Supervisores incluir (toda la región o un subset)\n• Universo de farmacias candidatas (por colonia, por status, etc.)\n\nMarzam reparte automáticamente entre los Representantes según capacidad.',
      },
      {
        id: 'review', kind: 'modal', placement: 'center',
        title: 'Revisión antes de publicar',
        body: 'Verás cuántas visitas le tocan a cada Representante y a cada Supervisor. Puedes ajustar manualmente si algo no te encaja.',
      },
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-assign-down'] = {
    id: 'gerente_ventas-assign-down',
    role: 'gerente_ventas',
    title: 'Asignar a Supervisores y Representantes',
    summary: 'Cómo dar farmacias específicas a un Supervisor o saltar al rep directamente.',
    icon: 'assign',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Dos formas de asignar',
        body: '• Por Supervisor: le dejas a tu Supervisor un grupo de farmacias y él decide qué Representante atiende cada una.\n• Directo a Representante: por excepción, asignas tú mismo. Útil cuando hay un cliente clave o una urgencia.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Desde Mi equipo',
        body: 'Entra al Supervisor o Representante objetivo y usa el buscador de farmacias para asignar.',
        onEnter: selectTab('team'),
      },
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-live-region'] = {
    id: 'gerente_ventas-live-region',
    role: 'gerente_ventas',
    title: 'En vivo de toda la región',
    summary: 'Cómo filtrar el mapa por Supervisor y reaccionar a alertas regionales.',
    icon: 'live',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo',
        body: 'Toca aquí.',
        onEnter: selectTab('live'),
      },
      {
        id: 'filter', kind: 'modal', placement: 'center',
        title: 'Filtra por Supervisor',
        body: 'Si tu región tiene varios Supervisores, puedes ver solo el equipo de uno. Útil para reuniones 1:1 o para diagnosticar un Supervisor con bajo rendimiento.',
      },
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-approve'] = {
    id: 'gerente_ventas-approve',
    role: 'gerente_ventas',
    title: 'Visitas que requieren tu firma',
    summary: 'Cuándo el Gerente revisa visitas en lugar del Supervisor.',
    icon: 'review',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Escalación a Gerencia',
        body: 'Normalmente las visitas las aprueba el Supervisor. Pero hay casos que escalan a ti:\n\n• Visitas con monto inusual\n• Reps cuyo Supervisor no respondió en X horas\n• Reportes marcados como "requiere validación de Gerencia"',
      },
      doneStep('Gerente'),
    ],
  };

  REG['gerente_ventas-analytics'] = {
    id: 'gerente_ventas-analytics',
    role: 'gerente_ventas',
    title: 'Analíticas regionales',
    summary: 'KPI por Supervisor y desglose para entender dónde poner foco.',
    icon: 'analytics',
    hierarchy: {
      canAssignTo: ['Supervisor', 'Representante'],
      canBeAssignedBy: ['Director'],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Abre Analíticas',
        body: 'Toca aquí.',
        onEnter: selectTab('analytics'),
      },
      {
        id: 'compare', kind: 'modal', placement: 'center',
        title: 'Comparar Supervisores',
        body: 'Ordena tus Supervisores por cumplimiento, costo por visita o cobertura. Identifica al que necesita coaching y al que está rindiendo arriba del promedio.',
      },
      doneStep('Gerente'),
    ],
  };

  // ╔══════════════════════════════════════════════════════════╗
  // ║ DIRECTOR_SUCURSAL                                         ║
  // ╚══════════════════════════════════════════════════════════╝

  REG['director_sucursal-onboarding'] = {
    id: 'director_sucursal-onboarding',
    role: 'director_sucursal',
    title: 'Bienvenida — Director',
    summary: 'Vista de toda la sucursal: Gerentes, Supervisores y Representantes.',
    icon: 'branch',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Tu rol como Director',
        body: 'Tienes la vista completa de tu sucursal: Gerentes, Supervisores y Representantes. Eres responsable de las metas de la sucursal y de coordinar a tus Gerentes.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mi sucursal',
        body: 'Aquí ves la cascada: Gerentes → Supervisores → Representantes. Cada nivel se expande con click.',
        onEnter: selectTab('team'),
      },
      {
        id: 'plan', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas a nivel sucursal',
        body: 'Defines metas por Gerente y puedes generar planes que abarquen toda la sucursal o subconjuntos.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'live', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo de la sucursal',
        body: 'Mapa con todos los Representantes activos hoy. Filtros por Gerente o Supervisor para enfocar.',
        onEnter: selectTab('live'),
      },
      {
        id: 'analytics', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Analíticas de sucursal',
        body: 'Dashboards a nivel sucursal: cumplimiento, cobertura, costo, calidad. Puedes desglosar por Gerente, Supervisor o Representante.',
        onEnter: selectTab('analytics'),
      },
      hierarchyStep('Como Director ves toda la cadena bajo tu sucursal:'),
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-sucursal'] = {
    id: 'director_sucursal-sucursal',
    role: 'director_sucursal',
    title: 'Navegar la sucursal',
    summary: 'Drill-down desde Gerente hasta Representante individual.',
    icon: 'hierarchy',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Mi sucursal',
        body: 'Toca aquí.',
        onEnter: selectTab('team'),
      },
      {
        id: 'levels', kind: 'modal', placement: 'center',
        title: 'Tres niveles',
        body: 'Empiezas en Gerentes. Click → ves sus Supervisores. Otro click → ves los Representantes de ese Supervisor. Y un click más → detalle del día del Representante.',
      },
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-plan-sucursal'] = {
    id: 'director_sucursal-plan-sucursal',
    role: 'director_sucursal',
    title: 'Planificación de sucursal',
    summary: 'Generar plan a nivel sucursal y definir metas por Gerente.',
    icon: 'plan',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="plan"]',
        placement: 'right', placementMobile: 'top',
        title: 'Plan & Metas',
        body: 'Toca aquí.',
        onEnter: selectTab('plan'),
      },
      {
        id: 'targets', kind: 'modal', placement: 'center',
        title: 'Metas por Gerente',
        body: 'Defines un objetivo de visitas semanal o mensual por Gerente. Cada Gerente luego reparte ese objetivo entre sus Supervisores y Representantes.',
      },
      {
        id: 'plan', kind: 'modal', placement: 'center',
        title: 'Plan a nivel sucursal',
        body: 'Puedes generar un plan que abarque toda la sucursal en una sola pasada. Marzam optimiza por Gerente respetando capacidad y geografía.',
      },
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-assign-managers'] = {
    id: 'director_sucursal-assign-managers',
    role: 'director_sucursal',
    title: 'Asignar trabajo a Gerentes',
    summary: 'Delegar carga a un Gerente o saltar a Supervisor / Representante por excepción.',
    icon: 'assign',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Cómo delegar',
        body: 'Lo normal: asignas a un Gerente y él reparte hacia abajo. Por excepción puedes saltarte un nivel y asignar directo a un Supervisor o Representante.',
      },
      {
        id: 'team', kind: 'spotlight',
        target: '#sidenav [data-tab="team"]',
        placement: 'right', placementMobile: 'top',
        title: 'Desde Mi sucursal',
        body: 'Entra al Gerente, Supervisor o Representante objetivo y usa la herramienta de asignación.',
        onEnter: selectTab('team'),
      },
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-live-sucursal'] = {
    id: 'director_sucursal-live-sucursal',
    role: 'director_sucursal',
    title: 'Monitor en vivo de la sucursal',
    summary: 'Vista de mapa completa con filtros por Gerente y Supervisor.',
    icon: 'live',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: true },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="live"]',
        placement: 'right', placementMobile: 'top',
        title: 'En vivo',
        body: 'Toca aquí.',
        onEnter: selectTab('live'),
      },
      {
        id: 'filters', kind: 'modal', placement: 'center',
        title: 'Filtros',
        body: 'Filtra por Gerente o por Supervisor para enfocar el mapa. Útil para revisar una zona específica o un equipo en particular.',
      },
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-approve'] = {
    id: 'director_sucursal-approve',
    role: 'director_sucursal',
    title: 'Visitas que escalan a Director',
    summary: 'Casos especiales que te llegan a ti para revisión final.',
    icon: 'review',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'intro', kind: 'modal', placement: 'center',
        title: 'Tu cola de aprobaciones',
        body: 'Te llegan visitas que:\n\n• Tienen un monto fuera de rango\n• Fueron rechazadas por el Supervisor y apeladas por el Representante\n• Marcadas como "requiere autorización de Director" según política',
      },
      doneStep('Director'),
    ],
  };

  REG['director_sucursal-reports'] = {
    id: 'director_sucursal-reports',
    role: 'director_sucursal',
    title: 'Reportes y dashboards',
    summary: 'Tus indicadores de sucursal y cómo accionar sobre ellos.',
    icon: 'analytics',
    hierarchy: {
      canAssignTo: ['Gerente', 'Supervisor', 'Representante'],
      canBeAssignedBy: [],
    },
    prerequisites: { needsAssignment: false, fallbackToDemo: false },
    steps: [
      {
        id: 'go', kind: 'spotlight',
        target: '#sidenav [data-tab="analytics"]',
        placement: 'right', placementMobile: 'top',
        title: 'Analíticas',
        body: 'Toca aquí.',
        onEnter: selectTab('analytics'),
      },
      {
        id: 'kpis', kind: 'modal', placement: 'center',
        title: 'KPI clave de sucursal',
        body: '• Cumplimiento general (% visitas vs. meta)\n• Cobertura territorial\n• Calidad de visitas (foto rechazada)\n• Comparativa entre Gerentes\n• Tendencia mensual',
      },
      {
        id: 'drill', kind: 'modal', placement: 'center',
        title: 'Desglose y acción',
        body: 'Puedes desglosar cada KPI por Gerente, Supervisor o Representante. El objetivo es identificar dónde poner la conversación: cuál Gerente requiere atención, cuál Supervisor está rindiendo bajo, etc.',
      },
      doneStep('Director'),
    ],
  };

  // ── Helper to enumerate by role for the help center ──────────
  window.TOUR_INDEX_BY_ROLE = function (role) {
    const out = [];
    for (const id of Object.keys(REG)) {
      if (REG[id].role === role) out.push(REG[id]);
    }
    return out;
  };
})();
