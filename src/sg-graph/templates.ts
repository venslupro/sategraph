import type {Analysis, Policy} from './policy.ts';

const control =
    'MATCH (c:GraphControl {key: \'orbit\', instance_id: $instance})';
const licensed = (v: string) => 'size(' + v +
    '.source_ids) > 0 AND all(src IN ' + v +
    '.source_ids WHERE src IN $sources)';
const visible = (v: string) => '(' + licensed(v) + ')';
const infoTypes = [
  'MEMBER_OF', 'OWNED_BY', 'OPERATED_BY', 'MANUFACTURED_BY', 'REGISTERED_BY',
  'PARTICIPATES_IN', 'HAS_CAPABILITY'
];
export {infoTypes};
const scope =
    'OPTIONAL MATCH (s:TopologyScenario {scenario_id: $scenario}) WHERE ' +
    licensed('s');
const time = (v: string) => '(' + v + '.analysis_ms = $at OR (' + v +
    '.valid_from_ms <= $at AND $at < ' + v + '.valid_to_ms))';
const gate = [
  control,
  scope,
  'OPTIONAL MATCH (a:Entity {entity_id: $from}) WHERE ' + visible('a'),
  'OPTIONAL MATCH (b:Entity {entity_id: $to}) WHERE ' + visible('b'),
  'WITH c,s,a,b, CASE WHEN s IS NULL THEN \'DATA_INSUFFICIENT\'',
  'WHEN coalesce(s.state,\'\') <> \'READY\' THEN \'SCENARIO_NOT_READY\'',
  'WHEN s.expires_ms IS NOT NULL AND $now >= s.expires_ms THEN \'SCENARIO_EXPIRED\'',
  'WHEN NOT coalesce(' + time('s') +
      ',false) OR NOT coalesce(s.orbit_manifest_id=$manifest AND s.model_version=$model AND $purpose IN s.purposes,false) THEN \'DATA_INSUFFICIENT\'',
  'WHEN size(s.scope_ids) > 512 OR coalesce(s.edge_count, -1) > 5000 THEN \'LIMIT_REACHED\'',
  'WHEN NOT coalesce(s.coverage_complete AND s.edge_count >= 0 AND a.entity_id IN s.scope_ids AND b.entity_id IN s.scope_ids,false) THEN \'DATA_INSUFFICIENT\'',
  // 所有范围节点及声明的边必须可核对；不能把缺失或未获许可的资料当作不存在。
  'WHEN size(s.scope_ids) <> COUNT { UNWIND s.scope_ids AS sid MATCH (n:Entity {entity_id:sid}) WHERE ' +
      licensed('n') +
      ' RETURN DISTINCT n.entity_id } THEN \'DATA_INSUFFICIENT\'',
  'WHEN s.edge_count <> COUNT { MATCH ()-[r:COMM_LINK {scenario_id:$scenario}]->() } THEN \'DATA_INSUFFICIENT\'',
  'WHEN s.edge_count <> COUNT { MATCH (u:Entity)-[r:COMM_LINK {scenario_id:$scenario}]->(v:Entity) WHERE ' +
      'u.entity_id IN s.scope_ids AND v.entity_id IN s.scope_ids AND r.edge_id =~ \'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\' AND size(r.evidence_refs)>0 AND all(ref IN r.evidence_refs WHERE ref =~ \'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\') AND ' +
      licensed('r') +
      ' AND r.input_manifest_id IS NOT NULL AND r.model_version IS NOT NULL AND r.purpose IS NOT NULL AND r.evidence_type IN [\'DECLARED\',\'DERIVED\',\'MODELED\']' +
      ' AND (r.analysis_ms IS NOT NULL OR r.valid_from_ms < r.valid_to_ms) RETURN DISTINCT r.edge_id } THEN \'DATA_INSUFFICIENT\'',
  'ELSE \'READY\' END AS gate',
].join(' ');
const edge =
    (r: string) => [r + '.scenario_id=$scenario',
                    r + '.input_manifest_id=$manifest',
                    r + '.model_version=$model', r + '.purpose=$purpose',
                    r + '.evidence_type IN $evidence',
                    'size(' + r + '.evidence_refs)>0', licensed(r), time(r),
                    'NOT ' + r + '.edge_id IN $excludeEdges']
                       .join(' AND ');
const node = (n: string) => n + '.entity_id IN s.scope_ids AND NOT ' + n +
    '.entity_id IN $exclude AND ' + visible(n);
const step = (r: string, incoming: boolean) => (incoming ? '<-' : '-') + '[' +
    r + ':COMM_LINK WHERE ' + edge(r) + ']' + (incoming ? '-' : '->');
const dto = (p: string) => '{ids:[n IN nodes(' + p +
    ') | n.entity_id], edges:[r IN relationships(' + p +
    ') | {id:r.edge_id, from:startNode(r).entity_id, to:endNode(r).entity_id, evidence_type:r.evidence_type, evidence:r.evidence_refs}]}';

/** 只有方向枚举和校验后的整数选择模板；语义谓词均在重复路径模式内。 */
export function analysisTemplate(op: Analysis, p: Policy) {
  if (!Number.isInteger(p.hops) || p.hops < 1 || p.hops > 12) {
    throw Error('INVALID_HOPS');
  }
  const rel = step('r', p.direction === 'IN');
  const pre = 'WITH s,a,b,gate WHERE gate=\'READY\' ';
  const repeat = '( (x:Entity)' + rel + '(y:Entity WHERE ' + node('y') +
      ') ){1,' + p.hops + '}';
  let body: string;
  if (op === 'path') {
    body = p.from === p.to ?
        pre + 'RETURN {ids:[a.entity_id],edges:[]} AS item' :
        pre + 'MATCH p = SHORTEST 1 (a) ' + repeat + ' (b) RETURN ' + dto('p') +
            ' AS item';
  } else if (op === 'neighbors') {
    body = pre + 'MATCH p = SHORTEST 1 (a) ' + repeat +
        ' (n:Entity) WITH a,n,length(p) AS hops ' +
        'WHERE a<>n AND ($mode=\'within\' OR hops=$hops) RETURN {id:n.entity_id,hops:hops} AS item ORDER BY hops,n.entity_id LIMIT 101';
  } else if (op === 'common-neighbors') {
    body = pre + 'MATCH (a)' + rel + '(n:Entity WHERE ' + node('n') +
        ') MATCH (b)' + step('r2', p.direction === 'IN') + '(n) ' +
        'WHERE n<>a AND n<>b WITH DISTINCT n RETURN {id:n.entity_id} AS item ORDER BY n.entity_id LIMIT 101';
  } else {
    body = pre + 'OPTIONAL MATCH (a)' + rel + '(n:Entity WHERE ' + node('n') +
        ') ' +
        'RETURN {edge_count:count(DISTINCT r),neighbor_count:count(DISTINCT CASE WHEN n<>a THEN n END)} AS item';
  }
  return gate + ' CALL (s,a,b,gate) { CALL (s,a,b,gate) { ' + body +
      ' } RETURN collect(item) AS items } ' +
      'RETURN {gate:gate,items:items,cursor:c.cursor} AS result';
}
const sceneDto =
    's{.scenario_id,.state,.analysis_ms,.valid_from_ms,.valid_to_ms,.expires_ms,.orbit_manifest_id,.model_version,.purposes}';
export type Listing = 'scenarios'|'scenario'|'system'|'members'|'relations';
export function listTemplate(op: Listing, incoming: boolean) {
  let body: string;
  if (op === 'scenarios' || op === 'scenario') {
    body = 'MATCH (s:TopologyScenario) WHERE ' + licensed('s') +
        (op === 'scenarios' ? ' AND s.scenario_id>$after' :
                              ' AND s.scenario_id=$root') +
        ' RETURN ' + sceneDto + ' AS item ORDER BY s.scenario_id LIMIT $take';
  } else if (op === 'system') {
    body = 'MATCH (s:Entity:System {entity_id:$root}) WHERE ' + licensed('s') +
        ' RETURN s{.entity_id,.display_name} AS item';
  } else {
    const members = op === 'members';
    const rel = '[r:' + (members ? 'MEMBER_OF' : infoTypes.join('|')) + ']';
    const pattern = (members ? '(a:Entity:System' : '(a:Entity') +
        ' {entity_id:$root})' +
        (incoming || members ? '<-' + rel + '-' : '-' + rel + '->') +
        '(n:Entity)';
    body = 'MATCH ' + pattern + ' WHERE ' +
        [
          visible('a'), visible('n'), licensed('r'), 'size(r.evidence_refs)>0',
          '($at IS NULL OR ' + time('r') + ')', '($type=\'\' OR type(r)=$type)',
          members ? 'n.entity_id>$after' : 'r.edge_id>$after'
        ].join(' AND ') +
        (members ?
             ' WITH DISTINCT n RETURN n{.entity_id,.display_name} AS item ORDER BY n.entity_id' :
             ' RETURN {edge_id:r.edge_id,type:type(r),from:startNode(r).entity_id,to:endNode(r).entity_id,evidence_refs:r.evidence_refs} AS item ORDER BY r.edge_id') +
        ' LIMIT $take';
  }
  return control + ' CALL () { CALL () { ' + body +
      ' } RETURN collect(item) AS items } RETURN {items:items,cursor:c.cursor} AS result';
}
