/* ==========================================================
   FMcriol — Crédito do criador (rodapé fixo, todas as páginas)
   ==========================================================
   Propositadamente FORA de qualquer base de dados/admin: o texto está
   escrito diretamente aqui no código, por isso não há nenhum formulário,
   botão ou rota da API que o consiga mudar a partir da aplicação em si.
   A única forma de o alterar é editando este ficheiro no código-fonte.

   Para usar: inclui isto em QUALQUER página HTML, antes do fecho de
   </body> (ou no <head>, tanto faz):
       <script src="/creator-credit.js"></script>

   (Ajusta o caminho "/creator-credit.js" se este ficheiro não estiver na
   raiz da pasta servida como estática — ex: "../creator-credit.js" se a
   página estiver numa subpasta e o ficheiro ficar um nível acima.) */
(function () {
  var CREATOR_NAME = 'Rafael Silva Coronel';

  function injectCreatorCredit() {
    if (document.getElementById('fmcriol-creator-credit')) return; // já injetado, não duplicar

    var style = document.createElement('style');
    style.textContent = [
      '#fmcriol-creator-credit{',
      '  position:fixed;left:0;right:0;bottom:0;z-index:999999;',
      '  display:flex;align-items:center;justify-content:center;',
      '  padding:4px 10px;font-size:11px;line-height:1.4;',
      '  font-family:"Segoe UI","Inter",-apple-system,BlinkMacSystemFont,sans-serif;',
      '  background:rgba(10,14,22,.85);color:#8a97ac;',
      '  border-top:1px solid rgba(255,255,255,.06);',
      '  pointer-events:none;user-select:none;',
      '}',
    ].join('');
    document.head.appendChild(style);

    var footer = document.createElement('div');
    footer.id = 'fmcriol-creator-credit';
    footer.textContent = 'Criador: ' + CREATOR_NAME;
    document.body.appendChild(footer);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectCreatorCredit);
  } else {
    injectCreatorCredit();
  }

  // Reinjeta se alguma outra parte da página limpar o <body> (ex: algum
  // router de página única a substituir o conteúdo todo) — mantém o
  // rodapé sempre presente independentemente do que o resto da app faça.
  var observer = new MutationObserver(function () {
    if (!document.getElementById('fmcriol-creator-credit')) injectCreatorCredit();
  });
  if (document.body) {
    observer.observe(document.body, { childList: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      observer.observe(document.body, { childList: true });
    });
  }
})();