Promise.all([
  fetch('catalog-head.json').then(function(r){ if(r.ok) return r.json(); return fetch('catalog.json').then(function(full){ if(!full.ok) throw new Error('catalog '+full.status); return full.json(); }); }),
  fetch('snapshot.json?v='+Date.now()).then(function(r){ if(!r.ok) throw new Error('snapshot '+r.status); return r.json(); })
]).then(function(payload){
  var catalog=payload[0], snap=payload[1];
  var $=function(id){return document.getElementById(id)};
  var detailCache=new Map();
  var currentPage=1;
  var perPage=window.innerWidth<=720?20:40;
  var filtered=[];
  var searchTimer=null;

  function esc(v){
    return String(v==null?'':v).replace(/[&<>"']/g,function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function safeUrl(v){
    try{var u=new URL(String(v||''));return /^https?:$/.test(u.protocol)?u.href:'#'}catch(e){return '#'}
  }
  function num(v){return Number(v||0).toLocaleString('zh-TW')}
  function money(v){return 'NT$ '+Number(v||0).toLocaleString('zh-TW',{maximumFractionDigits:2})}
  function dt(v){
    if(!v)return '-';
    var d=new Date(v);
    return Number.isNaN(d.getTime())?String(v):d.toLocaleString('zh-TW');
  }
  function yesno(v){return v?'是':'否'}
  function statusGroup(x){
    var s=String(x.affiliate_status||'unknown');
    if(s==='verified')return 'verified';
    if(['not_convertible','wrong_destination','help_center'].includes(s))return 'blocked';
    if(['retry','verification_failed'].includes(s))return 'retry';
    if(s==='queued')return 'queued';
    return 'unknown';
  }
  function statusLabel(x){
    return {
      unknown:'🟡 尚未判定',queued:'🟠 待測試',verified:'🟢 已驗證可分潤',
      blocked:'🔴 不可分潤',retry:'🔵 待重試'
    }[statusGroup(x)]||'尚未判定';
  }

  $('dbCount').textContent='資料庫 '+num(snap.database_products)+' 筆';
  $('dbUpdated').textContent='更新：'+dt(snap.generated_at);
  $('perPage').value=String(perPage);
  $('stats').innerHTML=[
    ['資料庫商品',snap.database_products],['本輪抓到',snap.captured_products],
    ['尚未判定',snap.affiliate_unknown],['待測試',snap.affiliate_queued],
    ['已驗證可分潤',snap.affiliate_ready],['留言池',snap.threads_ready],
    ['高分商品',snap.high_score_products],['分類數',snap.category_count],
    ['已掃分類',snap.category_completed],['更新時間',new Date(snap.generated_at).toLocaleString()]
  ].map(function(x){
    return '<div class="stat"><span>'+esc(x[0])+'</span><b>'+esc(x[1])+'</b></div>';
  }).join('');

  var categories=[...new Set(catalog.map(function(x){
    return (x.category_path||'未分類').split('>')[0].trim();
  }).filter(Boolean))].sort();
  $('cat').innerHTML='<option value="">全部分類</option>'+categories.map(function(x){
    return '<option value="'+esc(x)+'">'+esc(x)+'</option>';
  }).join('');

  var locations=[...new Set(catalog.map(function(x){
    return String(x.shop_location||'').trim();
  }).filter(Boolean))].sort();
  $('location').innerHTML='<option value="">全部地區</option>'+locations.map(function(x){
    return '<option value="'+esc(x)+'">'+esc(x)+'</option>';
  }).join('');

  function applyFilters(resetPage){
    var q=$('q').value.trim().toLowerCase();
    var aff=$('aff').value;
    var cat=$('cat').value;
    var shopType=$('shopType').value;
    var location=$('location').value;
    var priceRange=$('priceRange').value;
    var monthlyMin=Number($('monthlyMin').value||0);
    var soldMin=Number($('soldMin').value||0);
    var ratingMin=Number($('ratingMin').value||0);
    var reviewMin=Number($('reviewMin').value||0);
    var stockFilter=$('stockFilter').value;
    var discountFilter=$('discountFilter').value;
    var min=Number($('min').value||0);
    var sort=$('sort').value;

    function priceOk(price){
      price=Number(price||0);
      if(!priceRange)return true;
      if(priceRange==='2000+')return price>=2000;
      var parts=priceRange.split('-').map(Number);
      return price>=parts[0]&&price<=parts[1];
    }
    function shopOk(x){
      if(!shopType)return true;
      var mall=Boolean(Number(x.is_mall||0));
      var preferred=Boolean(Number(x.is_preferred||0));
      if(shopType==='mall')return mall;
      if(shopType==='preferred')return preferred;
      if(shopType==='mall_or_preferred')return mall||preferred;
      if(shopType==='ordinary')return !mall&&!preferred;
      return true;
    }
    function stockOk(x){
      if(!stockFilter)return true;
      var stock=Number(x.stock);
      if(stockFilter==='unknown')return stock<0||Number.isNaN(stock);
      if(stockFilter==='out')return stock===0;
      if(stockFilter==='in')return stock>0;
      return true;
    }

    filtered=catalog.filter(function(x){
      return Number(x.selection_score||0)>=min &&
        Number(x.sold||0)>=monthlyMin &&
        Number(x.historical_sold||0)>=soldMin &&
        Number(x.rating||0)>=ratingMin &&
        Number(x.rating_count||0)>=reviewMin &&
        priceOk(x.price) &&
        shopOk(x) &&
        stockOk(x) &&
        (!location||String(x.shop_location||'')===location) &&
        (!discountFilter||
          (discountFilter==='discounted'&&Number(x.discount||0)>0)||
          (discountFilter==='none'&&Number(x.discount||0)<=0)) &&
        (!q||((x.product_name||'')+' '+(x.category_path||'')+' '+(x.shop_location||'')).toLowerCase().includes(q)) &&
        (!aff||statusGroup(x)===aff) &&
        (!cat||(x.category_path||'未分類').startsWith(cat));
    });

    var key={
      score:'selection_score',trend:'trend_score',sold:'historical_sold',
      monthly:'sold',rating:'rating',reviews:'rating_count',likes:'liked_count',
      price_low:'price',price_high:'price',latest:'last_seen_at'
    }[sort]||'selection_score';

    filtered.sort(function(a,b){
      if(sort==='price_low')return Number(a.price||0)-Number(b.price||0);
      if(sort==='latest')return String(b.last_seen_at||'').localeCompare(String(a.last_seen_at||''));
      return Number(b[key]||0)-Number(a[key]||0);
    });

    updateFilterCount();
    if(resetPage)currentPage=1;
    renderPage();
  }

  function updateFilterCount(){
    var ids=['aff','cat','shopType','location','priceRange','monthlyMin','soldMin',
      'ratingMin','reviewMin','stockFilter','discountFilter','min'];
    var defaults={monthlyMin:'0',soldMin:'0',ratingMin:'0',reviewMin:'0',min:'55'};
    var count=ids.reduce(function(total,id){
      var value=String($(id).value||'');
      var def=Object.prototype.hasOwnProperty.call(defaults,id)?defaults[id]:'';
      return total+(value!==def?1:0);
    },0);
    var badge=$('filterCount');
    badge.textContent=count?String(count):'';
    badge.classList.toggle('show',count>0);
  }

  function renderPage(){
    var total=filtered.length;
    var pages=Math.max(1,Math.ceil(total/perPage));
    currentPage=Math.min(Math.max(1,currentPage),pages);
    var start=(currentPage-1)*perPage;
    var visible=filtered.slice(start,start+perPage);

    $('resultText').textContent=total?
      '符合 '+num(total)+' 筆，目前顯示第 '+num(start+1)+'–'+num(Math.min(start+perPage,total))+' 筆':
      '沒有符合條件的商品';
    $('pageText').textContent='第 '+currentPage+' / '+pages+' 頁';

    if(!visible.length){
      $('grid').innerHTML='<div class="empty">沒有符合目前條件的商品，請調整篩選。</div>';
    }else{
      $('grid').innerHTML=visible.map(function(x){
        return '<article class="card" data-key="'+esc(x.canonical_key)+'" data-shard="'+x.detail_shard+'">'+
          (x.image?'<img class="card-image" loading="lazy" decoding="async" src="'+safeUrl(x.image)+'" alt="">':
            '<div class="card-image"></div>')+
          '<div class="card-body">'+
            '<div class="row"><span class="score">'+Number(x.selection_score||0).toFixed(0)+'/100</span>'+
            '<span class="muted">成長 '+Number(x.trend_score||0).toFixed(1)+'</span></div>'+
            '<div class="name">'+esc(x.product_name)+'</div>'+
            '<div class="muted category">'+esc(x.category_path||'未分類')+'</div>'+
            '<div class="badges"><span class="badge">'+statusLabel(x)+'</span>'+
            '<span class="badge">月銷 '+num(x.sold)+'</span>'+
            '<span class="badge">累積 '+num(x.historical_sold)+'</span>'+
            '<span class="badge">⭐ '+Number(x.rating||0).toFixed(2)+'</span></div>'+
            '<div class="row"><b class="price">'+money(x.price)+'</b>'+
            '<button class="detail-btn" type="button">詳細數據</button></div>'+
          '</div></article>';
      }).join('');
    }

    document.querySelectorAll('.card[data-key]').forEach(function(card){
      card.addEventListener('click',function(){
        openDetailByRef(card.getAttribute('data-key'),Number(card.getAttribute('data-shard')));
      });
    });

    renderPagination(pages);
    window.history.replaceState(null,'','#page='+currentPage);
  }

  function renderPagination(pages){
    var html=[];
    html.push('<button class="page-btn" data-page="1" '+(currentPage<=1?'disabled':'')+'>首頁</button>');
    html.push('<button class="page-btn" data-page="'+(currentPage-1)+'" '+(currentPage<=1?'disabled':'')+'>上一頁</button>');

    var from=Math.max(1,currentPage-2),to=Math.min(pages,currentPage+2);
    for(var p=from;p<=to;p++){
      html.push('<button class="page-btn number-page '+(p===currentPage?'active':'')+'" data-page="'+p+'">'+p+'</button>');
    }

    html.push('<button class="page-btn" data-page="'+(currentPage+1)+'" '+(currentPage>=pages?'disabled':'')+'>下一頁</button>');
    html.push('<button class="page-btn" data-page="'+pages+'" '+(currentPage>=pages?'disabled':'')+'>末頁</button>');
    $('pagination').innerHTML=html.join('');

    $('pagination').querySelectorAll('[data-page]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var target=Number(btn.getAttribute('data-page'));
        if(!Number.isFinite(target))return;
        currentPage=Math.min(Math.max(1,target),pages);
        renderPage();
        window.scrollTo({top:0,behavior:'smooth'});
      });
    });
  }

  async function getDetailShard(shard){
    if(detailCache.has(shard))return detailCache.get(shard);
    var path='details/page-'+String(shard).padStart(4,'0')+'.json';
    var promise=fetch(path).then(function(r){
      if(!r.ok)throw new Error('detail '+r.status);
      return r.json();
    });
    detailCache.set(shard,promise);
    return promise;
  }

  async function openDetailByRef(key,shard){
    $('detailTitle').textContent='商品詳細資料';
    $('detailBody').innerHTML='<div class="loading">正在載入詳細資料…</div>';
    $('detailModal').classList.add('open');
    $('detailModal').setAttribute('aria-hidden','false');
    document.body.style.overflow='hidden';

    try{
      var rows=await getDetailShard(shard);
      var x=rows.find(function(r){return r.canonical_key===key});
      if(!x)throw new Error('找不到商品詳細資料');
      openDetail(x);
    }catch(err){
      $('detailBody').innerHTML='<div class="empty">詳細資料載入失敗：'+esc(err.message||err)+'</div>';
    }
  }

  function openDetail(x){
    $('detailTitle').textContent=x.product_name||'商品詳細資料';
    var stockText=Number(x.stock)===-1?'未知':num(x.stock);
    var priceRange=(Number(x.price_min||0)||Number(x.price_max||0))
      ?money(x.price_min||x.price)+' ～ '+money(x.price_max||x.price):money(x.price);
    var sources=Array.isArray(x.sources)?x.sources.join('\\n'):'';
    var keywords=Array.isArray(x.keywords)?x.keywords.join('、'):'';

    $('detailBody').innerHTML=
      '<div class="detail-top">'+
        '<div>'+(x.image?'<img src="'+safeUrl(x.image)+'" alt="">':'')+'</div>'+
        '<div>'+
          '<div class="muted">'+esc(x.category_path||'未分類')+'</div>'+
          '<div class="badges"><span class="badge">'+statusLabel(x)+'</span>'+
            (x.is_mall?'<span class="badge">商城</span>':'')+
            (x.is_preferred?'<span class="badge">優選</span>':'')+
          '</div>'+
          '<div class="detail-grid">'+
            detailItem('選品分數',Number(x.selection_score||0).toFixed(2)+'/100')+
            detailItem('趨勢分數',Number(x.trend_score||0).toFixed(2))+
            detailItem('月銷量 / 近期銷量',num(x.sold))+
            detailItem('累積銷量',num(x.historical_sold))+
            detailItem('收藏數',num(x.liked_count))+
            detailItem('評分',Number(x.rating||0).toFixed(3))+
            detailItem('評價數',num(x.rating_count))+
            detailItem('目前售價',money(x.price))+
            detailItem('價格區間',priceRange)+
            detailItem('折扣前價格',money(x.price_before_discount))+
            detailItem('折扣',num(x.discount))+
            detailItem('庫存',stockText)+
            detailItem('商城',yesno(x.is_mall))+
            detailItem('優選賣家',yesno(x.is_preferred))+
            detailItem('賣家地區',x.shop_location||'-')+
          '</div>'+
        '</div>'+
      '</div>'+
      '<div class="detail-section"><h3>商品識別</h3><div class="detail-grid">'+
        detailItem('商店 ID',x.shop_id||'-')+
        detailItem('商品 ID',x.item_id||'-')+
        detailItem('分類 ID',x.category_id||'-')+
        detailItem('商品唯一鍵',x.canonical_key||'-')+
        detailItem('首次發現',dt(x.first_seen_at))+
        detailItem('最後更新',dt(x.last_seen_at))+
      '</div></div>'+
      '<div class="detail-section"><h3>分潤狀態</h3><div class="detail-grid">'+
        detailItem('狀態',statusLabel(x))+
        detailItem('嘗試次數',num(x.affiliate_attempts))+
        detailItem('原因',x.affiliate_status_reason||'-')+
      '</div></div>'+
      '<div class="detail-section"><h3>歷史銷量變化</h3>'+historySection(x)+'</div>'+
      '<div class="detail-section"><h3>關鍵字</h3><div class="muted">'+esc(keywords||'-')+'</div></div>'+
      '<div class="detail-section"><h3>來源</h3><div class="muted" style="white-space:pre-wrap">'+esc(sources||'-')+'</div></div>'+
      '<div class="detail-section"><h3>連結</h3><div class="links">'+
        '<a class="linkbtn" target="_blank" rel="noopener noreferrer" href="'+safeUrl(x.link)+'">開啟商品頁</a>'+
        (x.affiliate_link?'<a class="linkbtn" target="_blank" rel="noopener noreferrer" href="'+safeUrl(x.affiliate_link)+'">開啟分潤連結</a>':'')+
      '</div></div>';
  }

  function historySection(x){
    var h=Array.isArray(x.sales_history)?x.sales_history:[];
    if(h.length<2)return '<div class="empty-chart">目前歷史資料不足。之後再次抓到這個商品時，圖表會逐步累積。</div>';
    var first=h[0],last=h[h.length-1];
    var cumulativeDelta=Math.max(0,Number(last.historical_sold||0)-Number(first.historical_sold||0));
    var monthlyDelta=Number(last.sold||0)-Number(first.sold||0);
    var days=Math.max(1,Math.round((new Date(last.date)-new Date(first.date))/86400000));
    var avg=cumulativeDelta/days;
    return '<div class="detail-grid">'+
      detailItem('圖表期間',first.date+' ～ '+last.date)+
      detailItem('期間累積銷量增加','+'+num(cumulativeDelta))+
      detailItem('平均每日累積增加',num(avg.toFixed(1)))+
      detailItem('月銷量起點',num(first.sold))+
      detailItem('月銷量最新',num(last.sold))+
      detailItem('月銷量變化',(monthlyDelta>=0?'+':'')+num(monthlyDelta))+
      '</div>'+lineChart(h,'historical_sold','累積銷量')+
      lineChart(h,'sold','月銷量 / 近期銷量')+historyTable(h);
  }

  function lineChart(points,field,label){
    var values=points.map(function(p){return Number(p[field]||0)});
    var min=Math.min.apply(null,values),max=Math.max.apply(null,values),range=Math.max(1,max-min);
    var w=760,h=220,padL=62,padR=18,padT=16,padB=36,iw=w-padL-padR,ih=h-padT-padB;
    var coords=points.map(function(p,i){
      return {x:padL+(points.length===1?0:(i/(points.length-1))*iw),
              y:padT+ih-((Number(p[field]||0)-min)/range)*ih,p:p};
    });
    var poly=coords.map(function(c){return c.x.toFixed(1)+','+c.y.toFixed(1)}).join(' ');
    var yTicks=[0,.5,1].map(function(t){
      var value=Math.round(min+range*t),y=padT+ih-t*ih;
      return '<line class="chart-grid" x1="'+padL+'" y1="'+y+'" x2="'+(w-padR)+'" y2="'+y+'"></line>'+
        '<text class="chart-axis" x="'+(padL-8)+'" y="'+(y+4)+'" text-anchor="end">'+esc(num(value))+'</text>';
    }).join('');
    var dots=coords.map(function(c,i){
      return '<circle class="chart-dot" cx="'+c.x+'" cy="'+c.y+'" r="'+(i===coords.length-1?4:2.4)+'">'+
        '<title>'+esc(c.p.date)+'：'+esc(num(c.p[field]))+'</title></circle>';
    }).join('');
    return '<div class="chart-box"><div class="chart-title"><b>'+esc(label)+'</b><span>'+
      esc(points[0].date)+' → '+esc(points[points.length-1].date)+'</span></div>'+
      '<svg class="chart-svg" viewBox="0 0 '+w+' '+h+'">'+yTicks+
      '<polyline class="chart-line" points="'+poly+'"></polyline>'+dots+
      '<text class="chart-axis" x="'+padL+'" y="'+(h-10)+'">'+esc(points[0].date)+'</text>'+
      '<text class="chart-axis" x="'+(w-padR)+'" y="'+(h-10)+'" text-anchor="end">'+
      esc(points[points.length-1].date)+'</text></svg></div>';
  }

  function historyTable(points){
    var recent=points.slice().reverse().slice(0,14);
    return '<div class="history-table-wrap"><table class="history-table"><thead><tr>'+
      '<th>日期</th><th>月銷量</th><th>累積銷量</th><th>售價</th><th>收藏</th><th>評價數</th>'+
      '</tr></thead><tbody>'+recent.map(function(p){
        return '<tr><td>'+esc(p.date)+'</td><td>'+num(p.sold)+'</td><td>'+num(p.historical_sold)+
          '</td><td>'+money(p.price)+'</td><td>'+num(p.liked_count)+'</td><td>'+num(p.rating_count)+'</td></tr>';
      }).join('')+'</tbody></table></div>';
  }

  function detailItem(label,value){
    return '<div class="detail-item"><span>'+esc(label)+'</span><b>'+esc(value==null?'-':value)+'</b></div>';
  }
  function closeDetail(){
    $('detailModal').classList.remove('open');
    $('detailModal').setAttribute('aria-hidden','true');
    document.body.style.overflow='';
  }

  $('detailClose').addEventListener('click',closeDetail);
  $('detailModal').addEventListener('click',function(e){if(e.target===$('detailModal'))closeDetail()});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')closeDetail()});

  ['aff','cat','sort','shopType','location','priceRange','monthlyMin','soldMin',
    'ratingMin','reviewMin','stockFilter','discountFilter','min'].forEach(function(id){
    $(id).addEventListener('change',function(){applyFilters(true)});
  });
  $('perPage').addEventListener('change',function(){
    perPage=Number($('perPage').value||40);
    currentPage=1;
    renderPage();
  });
  $('filterToggle').addEventListener('click',function(){
    var panel=$('advancedFilters');
    var open=panel.classList.toggle('open');
    $('filterToggle').childNodes[0].nodeValue=open?'收起篩選':'更多篩選';
  });
  $('resetFilters').addEventListener('click',function(){
    $('q').value='';
    $('aff').value='';
    $('cat').value='';
    $('sort').value='score';
    $('shopType').value='';
    $('location').value='';
    $('priceRange').value='';
    $('monthlyMin').value='0';
    $('soldMin').value='0';
    $('ratingMin').value='0';
    $('reviewMin').value='0';
    $('stockFilter').value='';
    $('discountFilter').value='';
    $('min').value='55';
    perPage=window.innerWidth<=720?20:40;
    $('perPage').value=String(perPage);
    applyFilters(true);
  });
  $('q').addEventListener('input',function(){
    clearTimeout(searchTimer);
    searchTimer=setTimeout(function(){applyFilters(true)},180);
  });

  var hashPage=Number((location.hash.match(/page=(\d+)/)||[])[1]||1);
  currentPage=Math.max(1,hashPage);
  applyFilters(false);
  $('resultText').textContent='先顯示精選商品，完整資料背景載入中…';
  fetch('catalog.json').then(function(r){
    if(!r.ok) throw new Error('catalog '+r.status);
    return r.json();
  }).then(function(fullCatalog){
    catalog=fullCatalog;
    var allCategories=[...new Set(catalog.map(function(x){
      return (x.category_path||'未分類').split('>')[0].trim();
    }).filter(Boolean))].sort();
    $('cat').innerHTML='<option value="">全部分類</option>'+allCategories.map(function(x){
      return '<option value="'+esc(x)+'">'+esc(x)+'</option>';
    }).join('');
    var allLocations=[...new Set(catalog.map(function(x){
      return String(x.shop_location||'').trim();
    }).filter(Boolean))].sort();
    $('location').innerHTML='<option value="">全部地區</option>'+allLocations.map(function(x){
      return '<option value="'+esc(x)+'">'+esc(x)+'</option>';
    }).join('');
    applyFilters(false);
  }).catch(function(err){
    $('resultText').textContent='目前顯示精選商品；完整資料載入失敗，請重新整理。';
    console.warn(err);
  });

}).catch(function(err){
  var main=document.querySelector('main');
  if(main)main.innerHTML='<div class="empty">網頁資料載入失敗：'+String(err&&err.message||err)+'</div>';
});
