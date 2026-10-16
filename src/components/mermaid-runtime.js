// This classic-script asset runs only inside an opaque, CSP-restricted iframe.
// It deliberately has no imports, network access, or access to notebook state.
(() => {
  const token = document.documentElement.dataset.job
  const root = document.getElementById('diagram')
  let accepted = false
  const send = message => parent.postMessage({ ...message, token }, '*')
  const config = {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: 20_000,
    maxEdges: 500,
    fontFamily: 'Arial, sans-serif',
    theme: 'neutral',
    dompurifyConfig: { FORBID_TAGS: ['script', 'iframe', 'img', 'image', 'foreignObject', 'form', 'input', 'object', 'embed'] },
    secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'htmlLabels', 'maxTextSize', 'maxEdges', 'dompurifyConfig'],
  }
  if (!token || !root || !window.mermaid) return
  window.mermaid.initialize(config)
  window.addEventListener('message', async event => {
    if (accepted || event.source !== parent || event.data?.token !== token || event.data?.type !== 'mermaid-render') return
    accepted = true
    const source = event.data.source
    if (typeof source !== 'string' || source.length > 20_000 || new TextEncoder().encode(source).length > 20_000 || source.split('\n').length > 500 || /^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) {
      send({ type: 'mermaid-error' })
      return
    }
    try {
      const { svg } = await window.mermaid.render('note-diagram', source, root)
      if (svg.length > 2_000_000) throw new Error('Diagram too large')
      const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const drawing = parsed.documentElement
      if (drawing.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Invalid diagram')
      // The final iframe cannot run scripts or fetch resources. Strip these
      // nodes and links too, including self-navigation inside that iframe.
      for (const node of drawing.querySelectorAll('script, iframe, image, img, foreignObject, foreignobject, form, input, object, embed, animate, set, animateMotion, animateTransform, meta, link, base')) node.remove()
      for (const node of [drawing, ...drawing.querySelectorAll('*')]) {
        for (const attr of [...node.attributes]) {
          if (/^on/i.test(attr.name) || ['href', 'src', 'target'].includes(attr.localName.toLowerCase())) node.removeAttributeNode(attr)
        }
      }
      const dimensions = (drawing.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
      const width = dimensions.length === 4 ? dimensions[2] : Number.parseFloat(drawing.getAttribute('width'))
      const height = dimensions.length === 4 ? dimensions[3] : Number.parseFloat(drawing.getAttribute('height'))
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error('Invalid diagram size')
      const output = new XMLSerializer().serializeToString(drawing)
      if (output.length > 2_000_000) throw new Error('Diagram too large')
      send({ type: 'mermaid-result', svg: output, width, height })
    } catch {
      send({ type: 'mermaid-error' })
    } finally {
      root.replaceChildren()
    }
  })
  send({ type: 'mermaid-ready' })
})()
