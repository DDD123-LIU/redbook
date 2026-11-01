// 日期：2026-10-21。Codex。只使用调用方已绑定的受支持Edge Tab，不建立浏览器连接。

/** 每次读取后先提交观察；无新增只表示停滞，永不据此声明全量结束。 */
export async function discoverFavorites(collector, tab, collectionBatchId, options = {}) {
  const { token, maxItems = 2, maxBatches = 1, advance = false } = options;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new TypeError('maxItems and maxBatches must be positive integers');
  }
  let checkpoint = options.checkpoint;
  const known = new Set(checkpoint?.observed_ids ?? []);
  const discovered = new Set();
  let last;
  for (let page = 0; page < maxBatches; page++) {
    collector.assertCurrent(token);
    let observation;
    try {
      observation = await tab.playwright.evaluate(({ limit, exclude }) => {
        const source_page = location.href;
        const observed_at = new Date().toISOString();
        const url = new URL(source_page);
        const text = document.body?.innerText ?? '';
        const page_state = /验证码|安全验证|扫码登录|登录后查看/.test(text) ? 'access_blocked'
          : url.hostname !== 'www.xiaohongshu.com' || !url.pathname.startsWith('/user/profile/') || url.searchParams.get('tab') !== 'fav'
            ? 'wrong_page' : /页面不见了|页面异常|访问频繁/.test(text) ? 'page_error' : 'ready';
        const sections = Array.from(document.querySelectorAll('section.note-item'));
        const observations = [];
        const seen = new Set(exclude);
        for (const section of sections) {
          const links = Array.from(section.querySelectorAll('a[href]'));
          const identity = links.map(a => a.getAttribute('href')).map(href => href?.match(/^\/explore\/([a-f0-9]{24})(?:[/?]|$)/i)?.[1]).find(Boolean);
          if (!identity || seen.has(identity)) continue;
          const source = links.map(a => new URL(a.getAttribute('href'), source_page))
            .find(link => link.hostname === url.hostname && link.pathname.endsWith('/' + identity) && link.searchParams.has('xsec_token'));
          if (!source) continue;
          seen.add(identity);
          observations.push({ content_id: identity, complete_source_url: source.href, observed_at, membership: 'present' });
          if (observations.length >= limit) break;
        }
        return {source_page, observed_at, page_state, dom_count:sections.length, observations,
          anchor_id:observations.at(-1)?.content_id ?? null};
      }, { limit: maxItems - discovered.size, exclude: [...known] }, { timeoutMs: 50000 });
    } catch {
      collector.assertCurrent(token);
      if (checkpoint?.source_page) {
        await collector.recordDiscovery(collectionBatchId, { token, observations: [], source_page: checkpoint.source_page,
          observed_at: new Date().toISOString(), source_kind:'live_page', read_method:'edge_dom_failed',
          anchor_id:checkpoint.anchor_id, coverage:{state:'partial',stop_reason:'browser_read_failed',complete:false} });
      }
      return {status:'unknown', entity_id:collectionBatchId, state:'unknown', evidence_refs:[], observed_ids:[...discovered],
        next_checkpoint:checkpoint, coverage:{state:'partial',complete:false,stop_reason:'browser_read_failed'}};
    }
    collector.assertCurrent(token);
    if (checkpoint?.source_page) {
      const oldSource = new URL(checkpoint.source_page);
      const currentSource = new URL(observation.source_page);
      if (oldSource.origin !== currentSource.origin || oldSource.pathname !== currentSource.pathname
        || oldSource.searchParams.get('subTab') !== currentSource.searchParams.get('subTab')) {
        return {status:'blocked',entity_id:collectionBatchId,state:'blocked',evidence_refs:[],observed_ids:[...discovered],
          next_checkpoint:checkpoint,coverage:{state:'partial',complete:false,stop_reason:'source_scope_mismatch'}};
      }
    }
    if (observation.page_state !== 'ready') {
      await collector.recordDiscovery(collectionBatchId, { ...observation, token, observations:[], source_kind:'live_page',read_method:'edge_dom',
        coverage:{state:'partial',complete:false,stop_reason:observation.page_state} });
      return {status:'blocked', entity_id:collectionBatchId, state:'blocked', evidence_refs:[], observed_ids:[...discovered],
        next_checkpoint:checkpoint, coverage:{state:'partial',complete:false,stop_reason:observation.page_state}};
    }
    const stopReason = observation.observations.length === 0 ? 'no_new_in_dom_window'
      : discovered.size + observation.observations.length >= maxItems ? 'bounded_sample' : 'batch_limit';
    last = await collector.recordDiscovery(collectionBatchId, { ...observation, token, source_kind:'live_page',read_method:'edge_dom',
      coverage:{state:'partial',complete:false,dom_count:observation.dom_count,stop_reason:stopReason,total_known:false} });
    for (const item of observation.observations) { known.add(item.content_id); discovered.add(item.content_id); }
    checkpoint = { ...last.next_checkpoint, source_page:observation.source_page,
      anchor_id:observation.anchor_id ?? checkpoint?.anchor_id, observed_ids:[...known] };
    if (!observation.observations.length || discovered.size >= maxItems || page + 1 >= maxBatches || !advance) break;
    collector.assertCurrent(token);
    // ponytail: 只推进当前已加载卡片；深层重连与全量覆盖留TASK-016，不猜像素或私有分页协议。
    try {
      await tab.playwright.locator(`section.note-item a[href*="/${checkpoint.anchor_id}"]`).first().press('PageDown');
    } catch {
      collector.assertCurrent(token);
      await collector.recordDiscovery(collectionBatchId, {token,observations:[],source_page:checkpoint.source_page,
        observed_at:new Date().toISOString(),source_kind:'live_page',read_method:'edge_scroll_failed',anchor_id:checkpoint.anchor_id,
        coverage:{state:'partial',complete:false,stop_reason:'browser_scroll_failed'}});
      return {status:'unknown',entity_id:collectionBatchId,state:'unknown',evidence_refs:[],observed_ids:[...discovered],next_checkpoint:checkpoint,
        coverage:{state:'partial',complete:false,stop_reason:'browser_scroll_failed'}};
    }
    collector.assertCurrent(token);
  }
  return { ...last, status:last?.status ?? 'succeeded', entity_id:collectionBatchId,
    evidence_refs:last?.evidence_refs ?? (last?.next_checkpoint?.checkpoint_id ? [`sqlite:checkpoint:${last.next_checkpoint.checkpoint_id}`] : []),
    observed_ids:[...discovered], next_checkpoint:checkpoint, state:'partial',
    coverage:last?.coverage ?? {state:'partial',complete:false,stop_reason:'batch_limit'} };
}

/** 代理入口：同一槽中分批发现并调用本地采集恢复；不包含调度或分析。 */
export async function runFavorites({collector, tab, collectionBatchId, ...options}) {
  const token = await collector.claim();
  try {
    const discovery = await discoverFavorites(collector, tab, collectionBatchId, {...options,token});
    if (['blocked','unknown'].includes(discovery.state)) return {status:discovery.state,entity_id:collectionBatchId,
      evidence_refs:discovery.evidence_refs ?? [],discovery, material:null};
    const material = await collector.resume(collectionBatchId, {token});
    return {status:material.status ?? (material.state === 'complete' ? 'succeeded' : material.state ?? 'unknown'),
      entity_id:collectionBatchId,evidence_refs:[...(discovery.evidence_refs ?? []),...(material.evidence_refs ?? [])],discovery,material};
  } finally {
    await collector.release(token);
  }
}
