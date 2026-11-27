export const SUPPORTED_LANGS = ['zh', 'en', 'pt'];

export const LANG_LABELS = {
  zh: { short: '中', name: '中文' },
  en: { short: 'EN', name: 'English' },
  pt: { short: 'PT', name: 'Português' },
};

export const I18N = {
  zh: {
    pageTitle: 'CTSC 极地破冰船 · Polar Icebreaker 3D',
    vesselTitle: '极地破冰航行',
    statSpeed: '航速',
    statHeading: '航向',
    statEngine: '主机',
    speedUnit: '节',
    engineAhead: (pct) => `进车 ${pct}%`,
    engineAstern: (pct) => `倒车 ${pct}%`,
    engineStop: '停机',
    btnReset: '重置航线',
    btnResetTitle: '重置航线与冰原 (R)',
    btnCleanView: '纯净视图',
    btnCleanViewTitle: '隐藏界面，欣赏纯净插画 (H)',
    btnShowHud: '显示界面',
    btnShowHudTitle: '恢复操作界面 (H)',
    langSwitchAria: '切换语言 (L)',
    hintThrottle: '<strong>W / S</strong> 进车 / 倒车',
    hintRudder: '<strong>A / D</strong> 左舵 / 右舵转向',
    btnStop: 'SPACE 停机',
    lenses: {
      illustration: {
        name: '插画俯视',
        tag: 'ILLUSTRATION',
        desc: '经典高机位长焦等轴构图，完整呈现冰原污点、长投影与碎冰航迹',
      },
      bow: {
        name: '船首破冰',
        tag: 'BOW BREAKER',
        desc: '低中机位贴近加强型破冰船首，聚焦冰层挤压与船体做旧细节',
      },
      aerial: {
        name: '航迹俯瞰',
        tag: 'AERIAL WAKE',
        desc: '高空俯瞰深蓝破冰航道与冰面放射状应力裂纹网络',
      },
      bridge: {
        name: '舰桥侧翼',
        tag: 'BRIDGE WING',
        desc: '建筑剖面式近景视角，展示舰桥翼台、橙色救生艇与停机坪细节',
      },
      stern: {
        name: '尾迹低角',
        tag: 'STERN CHASE',
        desc: '航道低视角尾随，观察螺旋桨白沫、浮冰与船尾停机坪甲板',
      },
    },
  },
  en: {
    pageTitle: 'CTSC Polar Icebreaker · 3D Ligne Claire Voyage',
    vesselTitle: 'Polar Icebreaker',
    statSpeed: 'SPEED',
    statHeading: 'HDG',
    statEngine: 'ENGINE',
    speedUnit: 'KT',
    engineAhead: (pct) => `AHEAD ${pct}%`,
    engineAstern: (pct) => `ASTERN ${pct}%`,
    engineStop: 'STOP',
    btnReset: 'Reset',
    btnResetTitle: 'Reset course and pack ice (R)',
    btnCleanView: 'Clean View',
    btnCleanViewTitle: 'Hide HUD for pure illustration view (H)',
    btnShowHud: 'Show HUD',
    btnShowHudTitle: 'Restore HUD controls (H)',
    langSwitchAria: 'Switch language (L)',
    hintThrottle: '<strong>W / S</strong> Ahead / Astern',
    hintRudder: '<strong>A / D</strong> Port / Starboard Rudder',
    btnStop: 'SPACE STOP',
    lenses: {
      illustration: {
        name: 'Illustration',
        tag: 'ILLUSTRATION',
        desc: 'Classic high telephoto isometric framing with cast shadow, snow specks and carved lead',
      },
      bow: {
        name: 'Bow Breaker',
        tag: 'BOW BREAKER',
        desc: 'Low three-quarter framing on the reinforced polar bow crushing pack ice and weathered hull',
      },
      aerial: {
        name: 'Aerial Wake',
        tag: 'AERIAL WAKE',
        desc: 'High overhead architectural view of the carved indigo lead and radial fracture plates',
      },
      bridge: {
        name: 'Bridge Wing',
        tag: 'BRIDGE WING',
        desc: 'Close architectural study of the wheelhouse wings, amber lifeboat and aft helideck',
      },
      stern: {
        name: 'Stern Chase',
        tag: 'STERN CHASE',
        desc: 'Low chase camera across propeller wash, floating floes and aft helideck superstructure',
      },
    },
  },
  pt: {
    pageTitle: 'CTSC Quebra-Gelo Polar · Navegação 3D Ligne Claire',
    vesselTitle: 'Quebra-Gelo Polar',
    statSpeed: 'VELOC.',
    statHeading: 'RUMO',
    statEngine: 'MOTOR',
    speedUnit: 'NÓS',
    engineAhead: (pct) => `AVANTE ${pct}%`,
    engineAstern: (pct) => `RÉ ${pct}%`,
    engineStop: 'PARAR',
    btnReset: 'Reiniciar',
    btnResetTitle: 'Reiniciar rota e banquisa (R)',
    btnCleanView: 'Modo Limpo',
    btnCleanViewTitle: 'Ocultar interface para visão de ilustração (H)',
    btnShowHud: 'Mostrar UI',
    btnShowHudTitle: 'Restaurar controles na tela (H)',
    langSwitchAria: 'Alternar idioma (L)',
    hintThrottle: '<strong>W / S</strong> Avante / Ré',
    hintRudder: '<strong>A / D</strong> Leme Bombordo / Boreste',
    btnStop: 'ESPAÇO PARAR',
    lenses: {
      illustration: {
        name: 'Ilustração',
        tag: 'ILUSTRAÇÃO',
        desc: 'Composição isométrica teleobjetiva com sombra longa, pontilhado no gelo e canal aberto',
      },
      bow: {
        name: 'Proa',
        tag: 'PROA QUEBRA-GELO',
        desc: 'Ângulo próximo à proa reforçada rompendo a banquisa com marcas de desgaste no casco',
      },
      aerial: {
        name: 'Vista Aérea',
        tag: 'ESTEIRA AÉREA',
        desc: 'Visão aérea arquitetônica do canal azul-escuro e da rede radial de fraturas no gelo',
      },
      bridge: {
        name: 'Ponte',
        tag: 'ASA DA PONTE',
        desc: 'Detalhe próximo das asas do passadiço, baleeira laranja e helideque de popa',
      },
      stern: {
        name: 'Popa',
        tag: 'PERSEGUIÇÃO À POPA',
        desc: 'Câmera baixa à ré destacando a espuma das hélices, blocos de gelo e convés de voo',
      },
    },
  },
};

export function detectInitialLang() {
  try {
    const params = new URLSearchParams(window.location.search);
    const q = (params.get('lang') || '').toLowerCase().slice(0, 2);
    if (q && SUPPORTED_LANGS.includes(q)) return q;

    const saved = window.localStorage.getItem('icebreaker_lang');
    if (saved && SUPPORTED_LANGS.includes(saved)) return saved;

    const navLang = (navigator.language || '').toLowerCase();
    if (navLang.startsWith('pt')) return 'pt';
    if (navLang.startsWith('en')) return 'en';
    if (navLang.startsWith('zh')) return 'zh';
  } catch {
    // Ignore storage/navigator errors
  }
  return 'zh';
}
