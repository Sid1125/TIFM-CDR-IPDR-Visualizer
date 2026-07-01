// core/dom.js — cached references to every DOM node the app touches, plus the $ helper.
// Extracted verbatim from app.js (step 3 of the frontend modularization). Built at module-eval
// time; safe because app.js loads as a deferred module, so the document is fully parsed before
// this runs. No behavior change.

export const $=id=>document.getElementById(id);

export const D={
  shell:$('shell'),auth:$('authOverlay'),loginForm:$('loginForm'),loginUser:$('loginUsername'),loginPass:$('loginPassword'),loginStatus:$('loginStatus'),
  sessionUser:$('sessionUser'),sessionStatus:$('sessionStatus'),logoutBtn:$('logoutBtn'),
  importStatus:$('importStatus'),cdrFile:$('cdrFile'),ipdrFile:$('ipdrFile'),towerFile:$('towerFile'),
  dashCards:$('dashCards'),crossCaseHits:$('crossCaseHits'),dashGraph:$('dashGraph'),dashPie:$('dashPieChart'),dashHeat:$('dashHeatmap'),dashBar:$('dashBarChart'),dashMatrix:$('dashMatrix'),
  graphSubject:$('graphSubject'),graphLimit:$('graphLimit'),graphSearch:$('graphSearchInput'),graphReset:$('graphResetZoom'),graphCenter:$('graphCenterBtn'),graphStats:$('graphStats'),graphShowTags:$('graphShowTags'),graphSvg:$('graphSvgContainer'),graphSidebar:$('graphSidebar'),graphDetails:$('graphNodeDetails'),
  mapSubject:$('mapSubject'),mapMode:$('mapMode'),mapGo:$('mapGoBtn'),mapFit:$('mapFitBtn'),geoFenceBtn:$('geoFenceBtn'),mapStage:$('mapStage'),mapSidebar:$('mapSidebar'),mapAnalysis:$('mapAnalysis'),mapTimeBar:$('mapTimelineBar'),mapTimeLabel:$('mapTimeLabel'),mapTimeSlider:$('mapTimeSlider'),mapTimePlay:$('mapTimePlay'),
  tlSearch:$('tlSearch'),tlType:$('tlType'),tlPlayBtn:$('tlPlayBtn'),tlCompare:$('tlCompare'),tlCount:$('tlCount'),tlContainer:$('tlContainer'),
  chartServPie:$('chartServicePie'),chartHourly:$('chartHourlyBar'),chartTopContacts:$('chartTopContacts'),chartServTimeline:$('chartServiceTimeline'),
  chartContactDir:$('chartContactDir'),chartContactDur:$('chartContactDur'),chartDayOfWeek:$('chartDayOfWeek'),
  chartDurDist:$('chartDurDist'),chartProtDist:$('chartProtDist'),chartTopPorts:$('chartTopPorts'),chartDataVol:$('chartDataVol'),chartTowerAct:$('chartTowerAct'),
  chartDailyTrend:$('chartDailyTrend'),chartPatternHeat:$('chartPatternHeat'),chartCdrIpdrTime:$('chartCdrIpdrTime'),chartCumulative:$('chartCumulative'),chartActiveSubjects:$('chartActiveSubjects'),chartNewReturning:$('chartNewReturning'),chartGeoState:$('chartGeoState'),chartTowerDiversity:$('chartTowerDiversity'),
  recSearch:$('recSearch'),recType:$('recType'),recService:$('recService'),recCount:$('recCount'),recBody:$('recBody'),recLoadMore:$('recLoadMore'),
  profile:$('profileModal'),profileTitle:$('profileTitle'),profileBody:$('profileBody'),profileClose:$('profileClose'),
  aiEndpoint:$('aiEndpoint'),aiModel:$('aiModel'),aiConfigSave:$('aiConfigSave'),aiStatus:$('aiStatus'),aiMode:$('aiMode'),aiSeedBtn:$('aiSeedBtn'),
  aiInvestigatorInput:$('aiInvestigatorInput'),aiAnalyzeBtn:$('aiAnalyzeBtn'),aiClearBtn:$('aiClearBtn'),aiResponse:$('aiResponse'),
  resetCaseBtn:$('resetCaseBtn'),
  aiGenerateReportBtn:null,aiReportContent:$('aiReportContent'),aiCopyReportBtn:$('aiCopyReportBtn'),aiCopyPackageBtn:$('aiCopyPackageBtn'),
  adminTabBtn:$('adminTabBtn'),adminBody:$('adminBody'),adminEmpty:$('adminEmpty'),adminTable:$('adminTable'),adminCreateBtn:$('adminCreateBtn'),
  auditBody:$('auditBody'),auditTable:$('auditTable'),auditEmpty:$('auditEmpty'),auditFilterUser:$('auditFilterUser'),auditFilterAction:$('auditFilterAction'),auditFilterFrom:$('auditFilterFrom'),auditRefreshBtn:$('auditRefreshBtn'),
  darkModeBtn:$('darkModeBtn'),exportBtn:$('exportBtn'),dossierBtn:$('dossierBtn'),dossier:$('dossier'),dossierBody:$('dossierBody'),dossierPrintBtn:$('dossierPrintBtn'),dossierCloseBtn:$('dossierCloseBtn'),caseSelector:$('caseSelector'),
  svcSearchInput:$('svcSearchInput'),svcMinConf:$('svcMinConf'),svcCount:$('svcCount'),svcBursts:$('svcBursts'),svcCardGrid:$('svcCardGrid'),
  corrSubA:$('corrSubA'),corrSubB:$('corrSubB'),corrGoBtn:$('corrGoBtn'),corrSwapBtn:$('corrSwapBtn'),corrResults:$('corrResults'),
  crossCaseTab:$('crossCaseTab'),xcRefreshBtn:$('xcRefreshBtn'),
  xcViewList:$('xcViewList'),xcViewGraph:$('xcViewGraph'),crossCaseGraph:$('crossCaseGraph'),xcGraphSvg:$('xcGraphSvg'),xcGraphDetails:$('xcGraphDetails'),xcGraphStats:$('xcGraphStats'),
  storySubject:$('storySubject'),storyFilters:$('storyFilters'),storyNarrative:$('storyNarrative'),storyTimeline:$('storyTimeline'),storyRefreshBtn:$('storyRefreshBtn'),
  evidenceToggleBtn:$('evidenceToggleBtn'),evidenceCount:$('evidenceCount'),evidencePanel:$('evidencePanel'),evidenceList:$('evidenceList'),evidenceClearBtn:$('evidenceClearBtn'),
  evidenceTab:$('evidenceTab'),evidenceTabCount:$('evidenceTabCount'),xcGraphCaptureBtn:$('xcGraphCaptureBtn'),
  towerRepo:$('towerRepo'),trSearch:$('trSearch'),trImportBtn:$('trImportBtn'),trImportFile:$('trImportFile'),trRefreshBtn:$('trRefreshBtn'),trRebuildBtn:$('trRebuildBtn'),trGeocodeBtn:$('trGeocodeBtn'),
  csGrid:$('csGrid'),csMeta:$('csMeta'),csBody:$('csBody'),
  cpStartA:$('cpStartA'),cpEndA:$('cpEndA'),cpStartB:$('cpStartB'),cpEndB:$('cpEndB'),cpGoBtn:$('cpGoBtn'),cpCloseBtn:$('cpCloseBtn'),cpStatus:$('cpStatus'),cpResults:$('cpResults'),compareBar:$('compareBar'),
};
