import type {Position, PublicSatellite, Satellite} from './orbit_types.ts';

export const EARTH_RADIUS = 6371;
export const MU = 398600.4418;
export const RAD = Math.PI / 180;
export const GROUPS = [
  {
    id: 'station',
    name: '空间站与科学',
    short: '空间科学',
    color: '#E3EDF8',
    operator: '多机构合作',
    purpose: '载人航天 / 空间科学'
  },
  {
    id: 'eo',
    name: '对地观测',
    short: '对地观测',
    color: '#6FE3FF',
    operator: '多机构',
    purpose: '对地观测'
  },
  {
    id: 'gps',
    name: 'GPS',
    short: 'GPS',
    color: '#5EA8FF',
    operator: '美国太空军',
    purpose: '卫星导航'
  },
  {
    id: 'bds',
    name: '北斗 / BDS',
    short: '北斗',
    color: '#FF8A3D',
    operator: '中国卫星导航系统管理办公室',
    purpose: '卫星导航'
  },
  {
    id: 'gal',
    name: 'Galileo',
    short: 'Galileo',
    color: '#B3A6FF',
    operator: '欧盟 / EUSPA',
    purpose: '卫星导航'
  },
  {
    id: 'glo',
    name: 'GLONASS',
    short: 'GLONASS',
    color: '#F07A9B',
    operator: '俄罗斯国家航天集团',
    purpose: '卫星导航'
  },
  {
    id: 'starlink',
    name: 'Starlink',
    short: 'Starlink',
    color: '#A9BCD0',
    operator: 'SpaceX',
    purpose: '卫星通信'
  },
  {
    id: 'iridium',
    name: 'Iridium NEXT',
    short: 'Iridium',
    color: '#3FD0A0',
    operator: 'Iridium Communications',
    purpose: '卫星通信'
  },
  {
    id: 'oneweb',
    name: 'OneWeb',
    short: 'OneWeb',
    color: '#D2E07A',
    operator: 'Eutelsat OneWeb',
    purpose: '卫星通信'
  },
  {
    id: 'relay',
    name: '中继卫星',
    short: '中继',
    color: '#FFC857',
    operator: '多机构',
    purpose: '数据中继'
  },
  {
    id: 'other',
    name: '其他 / 待分类',
    short: '待分类',
    color: '#788FAB',
    operator: '待补充',
    purpose: '待补充'
  }
];
export const GROUP_BY_ID = Object.fromEntries(GROUPS.map(g => [g.id, g]));

export const SOURCES = [
  {
    name: 'CelesTrak GP',
    tag: '轨道主数据',
    access: '公开 · 免登录',
    url: 'https://celestrak.org/NORAD/documentation/gp-data-formats.php',
    text:
        'OMM 字段的 JSON / CSV、NORAD 编号、轨道历元。支撑 SGP4 位置推算；不是实时遥测。最多每两小时获取一次。',
    status: '已实现接入'
  },
  {
    name: 'Space-Track',
    tag: '目录与历史',
    access: '注册账号 · 条款约束',
    url: 'https://www.space-track.org/documentation',
    text:
        'SATCAT、GP、GP_HISTORY、发射与再入信息。适合历史轨道及目录补全，需服务端账号、缓存及限流。',
    status: '推荐扩展'
  },
  {
    name: 'GCAT · J. McDowell',
    tag: '卫星档案',
    access: '公开 · CC BY 4.0',
    url: 'https://planet4589.org/space/gcat/',
    text:
        '载荷、发射、制造商、所有者、任务与事件目录，包含 TSV 文件。适合构建档案与跨来源编号映射。',
    status: '推荐扩展'
  },
  {
    name: 'ESA DISCOSweb',
    tag: '物理与任务属性',
    access: '注册 · API Token',
    url: 'https://discosweb.esoc.esa.int/',
    text:
        '质量、尺寸、形状、发射与所有者等信息。不提供监视系统的轨道或姿态星历；使用需遵守条款并署名。',
    status: '推荐扩展'
  },
  {
    name: 'SatNOGS DB',
    tag: '无线电与发射机',
    access: '公开 · CC BY-SA',
    url: 'https://docs.satnogs.org/projects/satnogs-db/en/stable/api.html',
    text:
        '卫星、发射机、频率及调制方式。社区数据需核验，不能据此推断实时星间链路。',
    status: '推荐扩展'
  },
  {
    name: 'IGS / MGEX',
    tag: 'GNSS 精密产品',
    access: '公开产品 · 依下载站要求',
    url: 'https://igs.org/mgex/',
    text:
        'GPS、北斗、Galileo 等多系统的精密轨道与钟差。适合导航专题增强，不是全体卫星目录。',
    status: '专题补充'
  },
  {
    name: '北斗系统官网',
    tag: '系统级公开资料',
    access: '公开文档',
    url:
        'http://www.beidou.gov.cn/zt/xwfbh/bdshjbxtjc/mtjj4/201901/t20190103_16977.html',
    text:
        '公开资料说明北斗三号具备 Ka 频段星间链路能力；不等于公开每个时刻的星对、时隙或路由。',
    status: '已核对文档'
  }
];

export function classifyName(name: string) {
  const n = String(name).toUpperCase();
  if (/BEIDOU|BEI DOU|北斗/.test(n)) {
    return 'bds';
  }
  if (/^GPS|NAVSTAR/.test(n)) {
    return 'gps';
  }
  if (/GALILEO|^GSAT0/.test(n)) {
    return 'gal';
  }
  if (/GLONASS/.test(n)) {
    return 'glo';
  }
  if (/^STARLINK/.test(n)) {
    return 'starlink';
  }
  if (/^IRIDIUM/.test(n)) {
    return 'iridium';
  }
  if (/^ONEWEB/.test(n)) {
    return 'oneweb';
  }
  if (/TDRS|TIANLIAN|天链/.test(n)) {
    return 'relay';
  }
  if (/^ISS |^ISS$|TIANHE|CSS |^CSS$|HST|HUBBLE|天宫/.test(n)) {
    return 'station';
  }
  if (/SENTINEL|LANDSAT|FENGYUN|GAOFEN|YAOGAN|^NOAA|METOP|^GOES/.test(n)) {
    return 'eo';
  }
  return 'other';
}
export function parseEpoch(value: unknown) {
  const v = String(value || '');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(v) ? v : v + 'Z');
}
export function normalizeOmm(rows: unknown): PublicSatellite[] {
  if (!Array.isArray(rows)) {
    throw new Error('轨道数据必须是 JSON 数组');
  }
  const seen = new Set();
  const result: PublicSatellite[] = [];
  for (const entry of rows as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = String(row.NORAD_CAT_ID ?? '');
    const epoch = parseEpoch(row.EPOCH);
    const num = (k: string) => typeof row[k] === 'number' ||
            (typeof row[k] === 'string' && row[k].trim()) ?
        Number(row[k]) :
        NaN;
    if (!/^\d{1,9}$/.test(id) || seen.has(id) || !Number.isFinite(epoch)) {
      continue;
    }
    const motion = num('MEAN_MOTION');
    const ecc = num('ECCENTRICITY');
    const inc = num('INCLINATION');
    if (!(motion > 0 && motion < 20 && ecc >= 0 && ecc < 1 && inc >= 0 &&
          inc <= 180)) {
      continue;
    }
    if (!['RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR',
          'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT']
             .every(k => Number.isFinite(num(k)))) {
      continue;
    }
    seen.add(id);
    const name = String(row.OBJECT_NAME || '未命名对象 ' + id).slice(0, 160);
    const a = Math.cbrt(MU / ((motion * 2 * Math.PI / 86400) ** 2));
    result.push({
      id,
      name,
      norad: id,
      cospar: String(row.OBJECT_ID || ''),
      group: classifyName(name),
      epoch,
      alt: a - EARTH_RADIUS,
      inc,
      raan: num('RA_OF_ASC_NODE'),
      period: 1440 / motion,
      eccentricity: ecc,
      omm: {
        OBJECT_NAME: name,
        OBJECT_ID: String(row.OBJECT_ID || ''),
        NORAD_CAT_ID: id,
        EPOCH: /[+-]\d\d:\d\d$/.test(String(row.EPOCH)) ?
            new Date(epoch).toISOString() :
            String(row.EPOCH),
        MEAN_MOTION: motion,
        ECCENTRICITY: ecc,
        INCLINATION: inc,
        RA_OF_ASC_NODE: num('RA_OF_ASC_NODE'),
        ARG_OF_PERICENTER: num('ARG_OF_PERICENTER'),
        MEAN_ANOMALY: num('MEAN_ANOMALY'),
        BSTAR: num('BSTAR'),
        MEAN_MOTION_DOT: num('MEAN_MOTION_DOT'),
        MEAN_MOTION_DDOT: num('MEAN_MOTION_DDOT'),
        ELEMENT_SET_NO: String(row.ELEMENT_SET_NO ?? '')
      },
      demo: false
    });
  }
  return result;
}
export function demoCatalog(): Satellite[] {
  const sats: Omit<Satellite, 'period'|'eccentricity'>[] = [];
  const configs: [string, number, number, number, number, number][] = [
    ['gps', 6, 4, 20180, 55, 360], ['bds', 3, 8, 21528, 55, 360],
    ['gal', 3, 8, 23222, 56, 360], ['glo', 3, 8, 19130, 64.8, 360],
    ['starlink', 8, 12, 550, 53, 360], ['iridium', 6, 11, 780, 86.4, 180],
    ['oneweb', 6, 6, 1200, 87.9, 180]
  ];
  for (const [group, planes, slots, alt, inc, spread] of configs) {
    for (let p = 0; p < planes; p++) {
      for (let s = 0; s < slots; s++) {
        sats.push({
          id: 'demo-' + group + '-' + p + '-' + s,
          name: (group === 'bds' ? '北斗三号' : GROUP_BY_ID[group].short) +
              ' P' + (p + 1) + '-' + String(s + 1).padStart(2, '0'),
          group,
          alt,
          inc,
          raan: spread * p / planes,
          u0: 360 * s / slots + 360 * p / (planes * slots),
          plane: p,
          slot: s,
          planes,
          slots,
          demo: true
        });
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    sats.push({
      id: 'demo-bds-geo-' + i,
      name: '北斗三号 GEO-' + (i + 1),
      group: 'bds',
      kind: 'geo',
      longitude: [80, 110.5, 140][i],
      alt: 35786,
      inc: 0,
      demo: true
    });
  }
  for (let i = 0; i < 6; i++) {
    sats.push({
      id: 'demo-relay-' + i,
      name: (i < 3 ? 'TDRS' : '天链') + ' · 示例 ' + (i % 3 + 1),
      group: 'relay',
      kind: 'geo',
      longitude: [-41, -171, -62, 77, 176.8, 10.6][i],
      alt: 35786,
      inc: 0,
      demo: true
    });
  }
  const named:
      [string, string, string, number, number, number, number, string][] = [
        [
          '25544', 'ISS · 国际空间站', 'station', 420, 51.64, 120, 30,
          '1998-067A'
        ],
        [
          '48274', '天宫空间站 · 天和核心舱', 'station', 385, 41.47, 250, 200,
          '2021-035A'
        ],
        [
          '20580', 'Hubble · 哈勃望远镜', 'station', 520, 28.47, 40, 300,
          '1990-037B'
        ],
        ['40697', 'Sentinel-2A', 'eo', 786, 98.57, 300, 0, '2015-028A'],
        ['42063', 'Sentinel-2B', 'eo', 786, 98.57, 300, 180, '2017-013A'],
        ['39084', 'Landsat 8', 'eo', 705, 98.2, 290, 90, '2013-008A'],
        ['49260', 'Landsat 9', 'eo', 705, 98.2, 290, 270, '2021-088A']
      ];
  for (const [norad, name, group, alt, inc, raan, u0, cospar] of named) {
    sats.push({
      id: norad,
      norad,
      name,
      group,
      alt,
      inc,
      raan,
      u0,
      cospar,
      demo: true
    });
  }
  return sats.map(
      s => ({
        ...s,
        period: 2 * Math.PI * Math.sqrt((EARTH_RADIUS + s.alt) ** 3 / MU) / 60,
        eccentricity: 0
      }));
}
export function circularPosition(s: Satellite, ms: number): Position {
  const t = (ms - Date.UTC(2026, 0, 1)) / 1000;
  const gmst = ((280.46061837 +
                 360.98564736629 * (ms / 86400000 + 2440587.5 - 2451545)) %
                360) *
      RAD;
  let u;
  if (s.kind === 'geo' && s.longitude !== undefined) {
    u = [Math.cos(s.longitude * RAD), Math.sin(s.longitude * RAD), 0];
  } else {
    const phase =
        (s.u0 || 0) * RAD + Math.sqrt(MU / (EARTH_RADIUS + s.alt) ** 3) * t;
    const a = (s.raan || 0) * RAD;
    const i = s.inc * RAD;
    const x = Math.cos(a) * Math.cos(phase) -
        Math.sin(a) * Math.sin(phase) * Math.cos(i);
    const y = Math.sin(a) * Math.cos(phase) +
        Math.cos(a) * Math.sin(phase) * Math.cos(i);
    u = [
      x * Math.cos(gmst) + y * Math.sin(gmst),
      -x * Math.sin(gmst) + y * Math.cos(gmst), Math.sin(phase) * Math.sin(i)
    ];
  }
  return {
    unit: u,
    physical: u.map(v => v * (EARTH_RADIUS + s.alt)),
    alt: s.alt,
    lat: Math.asin(u[2]) / RAD,
    lon: Math.atan2(u[1], u[0]) / RAD,
    speed: Math.sqrt(MU / (EARTH_RADIUS + s.alt))
  };
}
export function hasLineOfSight(a: number[], b: number[], margin = 0) {
  const delta = b.map((v, i) => v - a[i]);
  const den = delta.reduce((n, v) => n + v * v, 0);
  if (den === 0) {
    return false;
  }
  const t = Math.max(
      0, Math.min(1, -a.reduce((n, v, i) => n + v * delta[i], 0) / den));
  return a.reduce((n, v, i) => n + (v + t * delta[i]) ** 2, 0) >
      (EARTH_RADIUS + margin) ** 2;
}
export function relatedSatellites(
    selected: Satellite, catalog: Satellite[], limit = 16) {
  const launch = selected.cospar?.split(/(?<=[0-9])(?=[A-Z])/)[0];
  return catalog.filter(s => s.id !== selected.id && s.group === selected.group)
      .sort((a, b) => {
        const rank = (s: Satellite) =>
            (launch && s.cospar?.startsWith(launch) ? -10000 : 0) +
            Math.abs((s.raan || 0) - (selected.raan || 0)) +
            Math.abs(s.inc - selected.inc) * 3;
        return rank(a) - rank(b);
      })
      .slice(0, limit);
}
export function neighborIds(s: Satellite, catalog: Satellite[]) {
  if (s.plane === undefined || s.slot === undefined || s.slots === undefined) {
    return [];
  }
  const result = [];
  for (const t of catalog) {
    if (t.group !== s.group || t.plane === undefined || t.slot === undefined ||
        t.id === s.id) {
      continue;
    }
    const along = t.plane === s.plane &&
        (Math.abs(t.slot - s.slot) === 1 ||
         Math.abs(t.slot - s.slot) === s.slots - 1);
    const across = t.slot === s.slot && Math.abs(t.plane - s.plane) === 1;
    if (along || across) {
      result.push(t.id);
    }
  }
  return result;
}
export function orbitLabel(s: Satellite) {
  if (s.kind === 'geo' || s.alt > 34000 && s.alt < 37000 && s.inc < 3) {
    return 'GEO · 地球静止轨道附近';
  }
  if (s.alt < 2000) {
    return s.inc > 96 && s.inc < 101 ? 'LEO · 近极地轨道' : 'LEO · 近地轨道';
  }
  if (s.alt < 35786) {
    return 'MEO · 中地球轨道';
  }
  return '高轨道 / 其他';
}
export function displayRadius(alt: number) {
  return 1 + 0.9 * Math.sqrt(Math.max(0, alt) / 35786);
}
export function searchCatalog(catalog: Satellite[], query: string) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.filter(
      s => terms.every(
          t => [s.name, s.norad || '', s.cospar || '',
                GROUP_BY_ID[s.group].name]
                   .join(' ')
                   .toLowerCase()
                   .includes(t)));
}
