import { h, ref, computed, watch, onBeforeMount, nextTick } from 'vue'

import debounce from '../../utils/debounce.js'

const aggBucketSize = 1000

const scrollToEdges = [
  'start',
  'center',
  'end',
  'start-force',
  'center-force',
  'end-force'
]

const slice = Array.prototype.slice

let buggyRTL = void 0

// mobile Chrome takes the crown for this
function detectBuggyRTL () {
  const scroller = document.createElement('div')
  const spacer = document.createElement('div')

  scroller.setAttribute('dir', 'rtl')
  scroller.style.width = '1px'
  scroller.style.height = '1px'
  scroller.style.overflow = 'auto'

  spacer.style.width = '1000px'
  spacer.style.height = '1px'

  document.body.appendChild(scroller)
  scroller.appendChild(spacer)
  scroller.scrollLeft = -1000

  buggyRTL = scroller.scrollLeft >= 0

  scroller.remove()
}

function sumFn (acc, h) {
  return acc + h
}

function getScrollDetails (
  parent,
  child,
  beforeRef,
  afterRef,
  horizontal,
  rtl,
  stickyStart,
  stickyEnd
) {
  const
    parentCalc = parent === window ? document.scrollingElement || document.documentElement : parent,
    propElSize = horizontal === true ? 'offsetWidth' : 'offsetHeight',
    details = {
      scrollStart: 0,
      scrollViewSize: -stickyStart - stickyEnd,
      scrollMaxSize: 0,
      offsetStart: -stickyStart,
      offsetEnd: -stickyEnd
    }

  if (horizontal === true) {
    if (parent === window) {
      details.scrollStart = window.pageXOffset || window.scrollX || document.body.scrollLeft || 0
      details.scrollViewSize += window.innerWidth
    }
    else {
      details.scrollStart = parentCalc.scrollLeft
      details.scrollViewSize += parentCalc.clientWidth
    }
    details.scrollMaxSize = parentCalc.scrollWidth

    if (rtl === true) {
      details.scrollStart = (buggyRTL === true ? details.scrollMaxSize - details.scrollViewSize : 0) - details.scrollStart
    }
  }
  else {
    if (parent === window) {
      details.scrollStart = window.pageYOffset || window.scrollY || document.body.scrollTop || 0
      details.scrollViewSize += window.innerHeight
    }
    else {
      details.scrollStart = parentCalc.scrollTop
      details.scrollViewSize += parentCalc.clientHeight
    }
    details.scrollMaxSize = parentCalc.scrollHeight
  }

  if (beforeRef !== null) {
    for (let el = beforeRef.previousElementSibling; el !== null; el = el.previousElementSibling) {
      if (el.classList.contains('q-virtual-scroll--skip') === false) {
        details.offsetStart += el[ propElSize ]
      }
    }
  }

  if (afterRef !== null) {
    for (let el = afterRef.nextElementSibling; el !== null; el = el.nextElementSibling) {
      if (el.classList.contains('q-virtual-scroll--skip') === false) {
        details.offsetEnd += el[ propElSize ]
      }
    }
  }

  if (child !== parent) {
    const
      parentRect = parentCalc.getBoundingClientRect(),
      childRect = child.getBoundingClientRect()

    if (horizontal === true) {
      details.offsetStart += childRect.left - parentRect.left
      details.offsetEnd -= childRect.width
    }
    else {
      details.offsetStart += childRect.top - parentRect.top
      details.offsetEnd -= childRect.height
    }

    if (parent !== window) {
      details.offsetStart += details.scrollStart
    }
    details.offsetEnd += details.scrollMaxSize - details.offsetStart
  }

  return details
}

function setScroll (parent, scroll, horizontal, rtl) {
  if (parent === window) {
    if (horizontal === true) {
      if (rtl === true) {
        scroll = (buggyRTL === true ? document.body.scrollWidth - window.innerWidth : 0) - scroll
      }
      window.scrollTo(scroll, window.pageYOffset || window.scrollY || document.body.scrollTop || 0)
    }
    else {
      window.scrollTo(window.pageXOffset || window.scrollX || document.body.scrollLeft || 0, scroll)
    }
  }
  else if (horizontal === true) {
    if (rtl === true) {
      scroll = (buggyRTL === true ? parent.scrollWidth - parent.offsetWidth : 0) - scroll
    }
    parent.scrollLeft = scroll
  }
  else {
    parent.scrollTop = scroll
  }
}

function sumSize (sizeAgg, size, from, to) {
  if (from >= to) { return 0 }

  const
    lastTo = size.length,
    fromAgg = Math.floor(from / aggBucketSize),
    toAgg = Math.floor((to - 1) / aggBucketSize) + 1

  let total = sizeAgg.slice(fromAgg, toAgg).reduce(sumFn, 0)

  if (from % aggBucketSize !== 0) {
    total -= size.slice(fromAgg * aggBucketSize, from).reduce(sumFn, 0)
  }
  if (to % aggBucketSize !== 0 && to !== lastTo) {
    total -= size.slice(to, toAgg * aggBucketSize).reduce(sumFn, 0)
  }

  return total
}

const commonVirtScrollProps = {
  virtualScrollSliceSize: {
    type: [ Number, String ],
    default: null
  },

  virtualScrollSliceRatioBefore: {
    type: [ Number, String ],
    default: 1
  },

  virtualScrollSliceRatioAfter: {
    type: [ Number, String ],
    default: 1
  },

  virtualScrollItemSize: {
    type: [ Number, String ],
    default: 24
  },

  virtualScrollStickySizeStart: {
    type: [ Number, String ],
    default: 0
  },

  virtualScrollStickySizeEnd: {
    type: [ Number, String ],
    default: 0
  },

  tableColspan: [ Number, String ]
}

export const commonVirtPropsList = Object.keys(commonVirtScrollProps)

export const useVirtualScrollProps = {
  virtualScrollHorizontal: Boolean,
  ...commonVirtScrollProps
}

export const useVirtualScrollEmits = ['virtual-scroll']

export function useVirtualScroll ({
  props, emit, $q, vm, virtualScrollLength, getVirtualScrollTarget, getVirtualScrollEl,
  virtualScrollItemSizeComputed // optional
}) {
  let prevScrollStart, prevToIndex, localScrollViewSize, virtualScrollSizesAgg = [], virtualScrollSizes

  const virtualScrollPaddingBefore = ref(0)
  const virtualScrollPaddingAfter = ref(0)
  const virtualScrollSliceSizeComputed = ref({})

  const beforeRef = ref(null)
  const afterRef = ref(null)
  const contentRef = ref(null)

  const virtualScrollSliceRange = ref({ from: 0, to: 0 })

  const colspanAttr = computed(() => props.tableColspan !== void 0 ? props.tableColspan : 100)

  if (virtualScrollItemSizeComputed === void 0) {
    virtualScrollItemSizeComputed = computed(() => props.virtualScrollItemSize)
  }

  const needsReset = computed(() => virtualScrollItemSizeComputed.value + ';' + props.virtualScrollHorizontal)

  const needsSliceRecalc = computed(() =>
    needsReset.value + ';' + props.virtualScrollSliceRatioBefore + ';' + props.virtualScrollSliceRatioAfter
  )

  watch(needsSliceRecalc, () => { setVirtualScrollSize() })
  watch(needsReset, reset)

  function reset () {
    localResetVirtualScroll(prevToIndex, true)
  }

  function refresh (toIndex) {
    localResetVirtualScroll(toIndex === void 0 ? prevToIndex : toIndex)
  }

  function scrollTo (toIndex, edge) {
    const scrollEl = getVirtualScrollTarget()

    if (scrollEl === void 0 || scrollEl === null || scrollEl.nodeType === 8) {
      return
    }

    const scrollDetails = getScrollDetails(
      scrollEl,
      getVirtualScrollEl(),
      beforeRef.value,
      afterRef.value,
      props.virtualScrollHorizontal,
      $q.lang.rtl,
      props.virtualScrollStickySizeStart,
      props.virtualScrollStickySizeEnd
    )

    localScrollViewSize !== scrollDetails.scrollViewSize && setVirtualScrollSize(scrollDetails.scrollViewSize)

    setVirtualScrollSliceRange(
      scrollEl,
      scrollDetails,
      Math.min(virtualScrollLength.value - 1, Math.max(0, parseInt(toIndex, 10) || 0)),
      0,
      scrollToEdges.indexOf(edge) > -1 ? edge : (prevToIndex > -1 && toIndex > prevToIndex ? 'end' : 'start')
    )
  }

  function __onVirtualScrollEvt () {
    const scrollEl = getVirtualScrollTarget()

    if (scrollEl === void 0 || scrollEl === null || scrollEl.nodeType === 8) {
      return
    }

    const
      scrollDetails = getScrollDetails(
        scrollEl,
        getVirtualScrollEl(),
        beforeRef.value,
        afterRef.value,
        props.virtualScrollHorizontal,
        $q.lang.rtl,
        props.virtualScrollStickySizeStart,
        props.virtualScrollStickySizeEnd
      ),
      listLastIndex = virtualScrollLength.value - 1,
      listEndOffset = scrollDetails.scrollMaxSize - scrollDetails.offsetStart - scrollDetails.offsetEnd - virtualScrollPaddingAfter.value

    if (prevScrollStart === scrollDetails.scrollStart) {
      return
    }

    if (scrollDetails.scrollMaxSize <= 0) {
      setVirtualScrollSliceRange(scrollEl, scrollDetails, 0, 0)
      return
    }

    localScrollViewSize !== scrollDetails.scrollViewSize && setVirtualScrollSize(scrollDetails.scrollViewSize)

    updateVirtualScrollSizes(virtualScrollSliceRange.value.from)

    const scrollMaxStart = Math.floor(scrollDetails.scrollMaxSize -
      Math.max(scrollDetails.scrollViewSize, scrollDetails.offsetEnd) -
      Math.min(virtualScrollSizes[ listLastIndex ], scrollDetails.scrollViewSize / 2))

    if (scrollMaxStart > 0 && Math.ceil(scrollDetails.scrollStart) >= scrollMaxStart) {
      setVirtualScrollSliceRange(
        scrollEl,
        scrollDetails,
        listLastIndex,
        scrollDetails.scrollMaxSize - scrollDetails.offsetEnd - virtualScrollSizesAgg.reduce(sumFn, 0)
      )

      return
    }

    let
      toIndex = 0,
      listOffset = scrollDetails.scrollStart - scrollDetails.offsetStart,
      offset = listOffset

    if (listOffset <= listEndOffset && listOffset + scrollDetails.scrollViewSize >= virtualScrollPaddingBefore.value) {
      listOffset -= virtualScrollPaddingBefore.value
      toIndex = virtualScrollSliceRange.value.from
      offset = listOffset
    }
    else {
      for (let j = 0; listOffset >= virtualScrollSizesAgg[ j ] && toIndex < listLastIndex; j++) {
        listOffset -= virtualScrollSizesAgg[ j ]
        toIndex += aggBucketSize
      }
    }

    while (listOffset > 0 && toIndex < listLastIndex) {
      listOffset -= virtualScrollSizes[ toIndex ]
      if (listOffset > -scrollDetails.scrollViewSize) {
        toIndex++
        offset = listOffset
      }
      else {
        offset = virtualScrollSizes[ toIndex ] + listOffset
      }
    }

    setVirtualScrollSliceRange(
      scrollEl,
      scrollDetails,
      toIndex,
      offset
    )
  }

  function setVirtualScrollSliceRange (scrollEl, scrollDetails, toIndex, offset, align) {
    const alignForce = typeof align === 'string' && align.indexOf('-force') > -1
    const alignEnd = alignForce === true ? align.replace('-force', '') : align
    const alignRange = alignEnd === void 0
      ? (scrollDetails.scrollStart > prevScrollStart || toIndex > prevToIndex ? 'start' : 'end')
      : alignEnd

    let
      from = Math.max(0, Math.ceil(toIndex - virtualScrollSliceSizeComputed.value[ alignRange ])),
      to = from + virtualScrollSliceSizeComputed.value.total

    if (to > virtualScrollLength.value) {
      to = virtualScrollLength.value
      from = Math.max(0, to - virtualScrollSliceSizeComputed.value.total)
    }

    prevScrollStart = scrollDetails.scrollStart

    if (contentRef.value !== null && contentRef.value.contains(document.activeElement)) {
      contentRef.value.focus()
    }

    const rangeChanged = from !== virtualScrollSliceRange.value.from || to !== virtualScrollSliceRange.value.to

    if (rangeChanged === false && alignEnd === void 0) {
      emitScroll(toIndex)
      return
    }

    const sizeBefore = alignEnd !== void 0 ? virtualScrollSizes.slice(from, toIndex).reduce(sumFn, 0) : 0

    if (rangeChanged === true) {
      virtualScrollSliceRange.value = { from, to }
      virtualScrollPaddingBefore.value = sumSize(virtualScrollSizesAgg, virtualScrollSizes, 0, from)
      virtualScrollPaddingAfter.value = sumSize(virtualScrollSizesAgg, virtualScrollSizes, to, virtualScrollLength.value)
    }

    requestAnimationFrame(() => {
      // if the scroll was changed give up
      // (another call to setVirtualScrollSliceRange before animation frame)
      if (prevScrollStart !== scrollDetails.scrollStart) {
        return
      }

      if (rangeChanged === true) {
        updateVirtualScrollSizes(from)
      }

      const
        sizeAfter = virtualScrollSizes.slice(from, toIndex).reduce(sumFn, 0),
        posStart = sizeAfter + scrollDetails.offsetStart + virtualScrollPaddingBefore.value,
        posEnd = posStart + virtualScrollSizes[ toIndex ]

      let scrollPosition = posStart + offset

      if (alignEnd !== void 0) {
        const sizeDiff = sizeAfter - sizeBefore
        const scrollStart = scrollDetails.scrollStart + sizeDiff

        scrollPosition = alignForce !== true && scrollStart < posStart && posEnd < scrollStart + scrollDetails.scrollViewSize
          ? scrollStart
          : (
              alignEnd === 'end'
                ? posEnd - scrollDetails.scrollViewSize
                : posStart - (alignEnd === 'start' ? 0 : Math.round((scrollDetails.scrollViewSize - virtualScrollSizes[ toIndex ]) / 2))
            )
      }

      prevScrollStart = scrollPosition

      setScroll(
        scrollEl,
        scrollPosition,
        props.virtualScrollHorizontal,
        $q.lang.rtl
      )

      emitScroll(toIndex)
    })
  }

  function updateVirtualScrollSizes (from) {
    const contentEl = contentRef.value

    if (contentEl) {
      const
        children = slice.call(contentEl.children)
          .filter(el => el.classList.contains('q-virtual-scroll--skip') === false),
        childrenLength = children.length,
        sizeFn = props.virtualScrollHorizontal === true
          ? el => el.getBoundingClientRect().width
          : el => el.offsetHeight

      let
        index = from,
        size, diff

      for (let i = 0; i < childrenLength;) {
        size = sizeFn(children[ i ])
        i++

        while (i < childrenLength && children[ i ].classList.contains('q-virtual-scroll--with-prev') === true) {
          size += sizeFn(children[ i ])
          i++
        }

        diff = size - virtualScrollSizes[ index ]

        if (diff !== 0) {
          virtualScrollSizes[ index ] += diff
          virtualScrollSizesAgg[ Math.floor(index / aggBucketSize) ] += diff
        }

        index++
      }
    }
  }

  function localResetVirtualScroll (toIndex, fullReset) {
    const defaultSize = virtualScrollItemSizeComputed.value

    if (fullReset === true || Array.isArray(virtualScrollSizes) === false) {
      virtualScrollSizes = []
    }

    const oldVirtualScrollSizesLength = virtualScrollSizes.length

    virtualScrollSizes.length = virtualScrollLength.value

    for (let i = virtualScrollLength.value - 1; i >= oldVirtualScrollSizesLength; i--) {
      virtualScrollSizes[ i ] = defaultSize
    }

    const jMax = Math.floor((virtualScrollLength.value - 1) / aggBucketSize)
    virtualScrollSizesAgg = []
    for (let j = 0; j <= jMax; j++) {
      let size = 0
      const iMax = Math.min((j + 1) * aggBucketSize, virtualScrollLength.value)
      for (let i = j * aggBucketSize; i < iMax; i++) {
        size += virtualScrollSizes[ i ]
      }
      virtualScrollSizesAgg.push(size)
    }

    prevToIndex = -1
    prevScrollStart = void 0

    if (toIndex >= 0) {
      updateVirtualScrollSizes(virtualScrollSliceRange.value.from)
      nextTick(() => { scrollTo(toIndex) })
    }
    else {
      virtualScrollPaddingBefore.value = sumSize(virtualScrollSizesAgg, virtualScrollSizes, 0, virtualScrollSliceRange.value.from)
      virtualScrollPaddingAfter.value = sumSize(virtualScrollSizesAgg, virtualScrollSizes, virtualScrollSliceRange.value.to, virtualScrollLength.value)
      onVirtualScrollEvt()
    }
  }

  function setVirtualScrollSize (scrollViewSize) {
    if (scrollViewSize === void 0 && typeof window !== 'undefined') {
      const scrollEl = getVirtualScrollTarget()

      if (scrollEl !== void 0 && scrollEl !== null && scrollEl.nodeType !== 8) {
        scrollViewSize = getScrollDetails(
          scrollEl,
          getVirtualScrollEl(),
          beforeRef.value,
          afterRef.value,
          props.virtualScrollHorizontal,
          $q.lang.rtl,
          props.virtualScrollStickySizeStart,
          props.virtualScrollStickySizeEnd
        ).scrollViewSize
      }
    }

    localScrollViewSize = scrollViewSize

    const multiplier = 1 + props.virtualScrollSliceRatioBefore + props.virtualScrollSliceRatioAfter
    const onView = Math.ceil(Math.max(
      scrollViewSize === void 0 || scrollViewSize <= 0
        ? 10
        : scrollViewSize / virtualScrollItemSizeComputed.value,
      props.virtualScrollSliceSize / multiplier
    ))

    virtualScrollSliceSizeComputed.value = {
      total: Math.ceil(onView * multiplier),
      start: Math.ceil(onView * props.virtualScrollSliceRatioBefore),
      center: Math.ceil(onView * (0.5 + props.virtualScrollSliceRatioBefore)),
      end: Math.ceil(onView * (1 + props.virtualScrollSliceRatioBefore)),
      view: scrollViewSize === void 0 || scrollViewSize <= 0
        ? 1
        : Math.ceil(scrollViewSize / virtualScrollItemSizeComputed.value)
    }
  }

  function padVirtualScroll (tag, content) {
    const paddingSize = props.virtualScrollHorizontal === true ? 'width' : 'height'

    return [
      tag === 'tbody'
        ? h(tag, {
            class: 'q-virtual-scroll__padding',
            key: 'before',
            ref: beforeRef
          }, [
            h('tr', [
              h('td', {
                style: { [ paddingSize ]: `${virtualScrollPaddingBefore.value}px` },
                colspan: colspanAttr.value
              })
            ])
          ])
        : h(tag, {
          class: 'q-virtual-scroll__padding',
          key: 'before',
          ref: beforeRef,
          style: { [ paddingSize ]: `${virtualScrollPaddingBefore.value}px` }
        }),

      h(tag, {
        class: 'q-virtual-scroll__content',
        key: 'content',
        ref: contentRef,
        tabindex: -1
      }, content),

      tag === 'tbody'
        ? h(tag, {
            class: 'q-virtual-scroll__padding',
            key: 'after',
            ref: afterRef
          }, [
            h('tr', [
              h('td', {
                style: { [ paddingSize ]: `${virtualScrollPaddingAfter.value}px` },
                colspan: colspanAttr.value
              })
            ])
          ])
        : h(tag, {
          class: 'q-virtual-scroll__padding',
          key: 'after',
          ref: afterRef,
          style: { [ paddingSize ]: `${virtualScrollPaddingAfter.value}px` }
        })
    ]
  }

  function emitScroll (index) {
    if (prevToIndex !== index) {
      vm.vnode.props.onVirtualScroll === true && emit('virtual-scroll', {
        index,
        from: virtualScrollSliceRange.value.from,
        to: virtualScrollSliceRange.value.to - 1,
        direction: index < prevToIndex ? 'decrease' : 'increase',
        ref: vm.proxy
      })

      prevToIndex = index
    }
  }

  setVirtualScrollSize()
  const onVirtualScrollEvt = debounce(__onVirtualScrollEvt, $q.platform.is.ios === true ? 120 : 50)

  onBeforeMount(() => {
    buggyRTL === void 0 && detectBuggyRTL()
    setVirtualScrollSize()
  })

  // expose public methods
  Object.assign(vm.proxy, {
    scrollTo, reset, refresh
  })

  return {
    virtualScrollSliceRange,
    virtualScrollSliceSizeComputed,

    setVirtualScrollSize,
    onVirtualScrollEvt,
    localResetVirtualScroll,
    padVirtualScroll,

    scrollTo,
    reset,
    refresh
  }
}
