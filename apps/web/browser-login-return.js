'use strict';

// Navigation hints only: authentication, ownership and workspace readiness remain server decisions.
(() => {
  const pages=new Set(['dashboard.html','host-install.html','machines.html','listings.html',
    'publish.html','bookings.html','revenues.html','workspaces.html','index.html',
    'stage3-windows-native.html']);
  const identifier=/^[A-Za-z0-9_-]{1,128}$/;
  const workspaceSlug=/^[a-z0-9][a-z0-9-]{0,63}$/;

  function safeReturnPath(value){
    if(typeof value!=='string'||value.length>512||/[\s\\#\x00-\x1f\x7f]/.test(value))return 'dashboard.html';
    const [path,query,...extra]=value.split('?');
    if(extra.length)return 'dashboard.html';
    const page=path.endsWith('.html')?path:`${path}.html`;
    if(pages.has(page)&&query===undefined)return page;
    if(page!=='choose-workspace.html'||query===undefined)return 'dashboard.html';
    const params=new URLSearchParams(query);
    if([...params.keys()].some(key=>!['listing','workspace'].includes(key))||
      params.getAll('listing').length!==1||params.getAll('workspace').length>1||
      !identifier.test(params.get('listing')||'')||
      (params.has('workspace')&&!workspaceSlug.test(params.get('workspace')||'')))return 'dashboard.html';
    const result=new URLSearchParams({listing:params.get('listing')});
    if(params.has('workspace'))result.set('workspace',params.get('workspace'));
    return `choose-workspace.html?${result}`;
  }

  function workspaceChoicePath(listing,workspace){
    return safeReturnPath(`choose-workspace.html?${new URLSearchParams({listing,workspace})}`);
  }

  window.GPUBNB_BROWSER_NAVIGATION=Object.freeze({
    safeReturnPath,workspaceChoicePath,
    loginHref:next=>`auth.html?next=${encodeURIComponent(safeReturnPath(next))}`,
  });
})();
