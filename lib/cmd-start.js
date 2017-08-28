var gzipMaybe = require('http-gzip-maybe')
var gzipSize = require('gzip-size')
var getPort = require('getport')
var http = require('http')
var pump = require('pump')

var ansi = require('ansi-escape-sequences')
var differ = require('ansi-diff-stream')
var pretty = require('prettier-bytes')
var nanoraf = require('nanoraf')

var Router = require('./regex-router')
var bankai = require('../')

var StartDelimiter = '|'
var EndDelimiter = '|'
var Filled = '█'
var Empty = '░'

var files = [
  'manifest',
  'assets',
  'serviceWorker',
  'script',
  'style',
  'document'
]

module.exports = start

function start (entry, opts) {
  var quiet = !!opts.quiet
  var compiler = bankai(entry)
  var router = new Router()
  var state = {
    files: {},
    size: 0
  }

  files.forEach(function (filename) {
    state.files[filename] = {
      name: filename,
      progress: 0,
      timestamp: '        ',
      size: 0,
      status: 'pending',
      done: false
    }
  })

  if (!quiet) {
    var diff = differ()
    diff.pipe(process.stdout)
    var render = nanoraf(function () {
      diff.write(view(state))
    }, raf)
  }

  compiler.on('error', function (error) {
    state.error = error.message + error.stack
    if (!quiet) render()
  })

  compiler.on('change', function (nodeName, edgeName, nodeState) {
    var node = nodeState[nodeName][edgeName]
    var data = {
      name: nodeName,
      progress: 100,
      timestamp: time(),
      size: 0,
      status: 'done',
      done: true
    }
    state.files[nodeName] = data

    // Only calculate the gzip size if there's a buffer. Apparently zipping
    // an empty file means it'll pop out with a 20B base size.
    if (node.buffer.length) {
      gzipSize(node.buffer, function (err, size) {
        if (err) data.size = node.buffer.length
        else data.size = size
        if (!quiet) render()
      })
    }
    if (!quiet) render()
  })

  router.route(/^\/manifest.json$/, function (req, res, params) {
    cors(req, res)
    compiler.manifest(function (err, node) {
      if (err) {
        res.statusCode = 404
        return res.end(err.message)
      }
      res.setHeader('content-type', 'application/json')
      gzip(node.buffer, req, res)
    })
  })

  router.route(/\/(service-worker)|(sw).js$/, function (req, res, params) {
    cors(req, res)
    compiler.serviceWorker(function (err, node) {
      if (err) {
        res.statusCode = 404
        return res.end(err.message)
      }
      res.setHeader('content-type', 'application/javascript')
      gzip(node.buffer, req, res)
    })
  })

  router.route(/\/([a-zA-Z0-9-_]+)\.js$/, function (req, res, params) {
    var name = params[1]
    cors(req, res)
    compiler.script(name, function (err, node) {
      if (err) {
        res.statusCode = 404
        return res.end(err.message)
      }
      res.setHeader('content-type', 'application/javascript')
      gzip(node.buffer, req, res)
    })
  })

  router.route(/\/bundle.css$/, function (req, res, params) {
    cors(req, res)
    compiler.style(function (err, node) {
      if (err) {
        res.statusCode = 404
        return res.end(err.message)
      }
      res.setHeader('content-type', 'text/css')
      gzip(node.buffer, req, res)
    })
  })

  router.default(function (req, res) {
    var url = req.url
    cors(req, res)
    compiler.document(url, function (err, node) {
      if (err) {
        res.statusCode = 404
        return res.end(err.message)
      }
      res.setHeader('content-type', 'text/html')
      gzip(node.buffer, req, res)
    })
  })

  // Start listening on an unused port.
  var server = http.createServer(router.match)
  getPort(8080, 9000, function (err, port) {
    if (err) state.error = err
    server.listen(port, function () {
      state.url = 'http://localhost:' + port
    })
  })
}

function view (state) {
  var size = Object.keys(state.files).reduce(function (num, filename) {
    var file = state.files[filename]
    return num + file.size
  }, 0)
  var totalSize = clr(pretty(size).replace(' ', ''), 'magenta')

  var SSEStatus = 'waiting for connection'
  SSEStatus = SSEStatus === 'connected'
    ? clr(SSEStatus, 'green')
    : clr(SSEStatus, 'yellow')

  var files = [
    'manifest',
    'assets',
    'service-worker',
    'script',
    'style',
    'document'
  ]
  var str = ''

  if (!state.url) {
    str += 'Waiting for server to start\n\n'
  } else {
    str += `Listening on ${clr(state.url, 'underline')}\n\n`
  }

  if (state.error) {
    str += (clr(state.error, 'red') + '\n\n')
  } else {
    str += files.reduce(function (str, filename) {
      var file = state.files[filename]
      if (!file) return ''
      var status = file.status
      if (status === 'done') status = clr(status, 'green')

      var size = pretty(file.size).replace(' ', '')
      str += '  '
      str += (clr(file.name, 'green') + whitespace(14 - file.name.length))
      str += whitespace(7 - size.length) + clr(size, 'magenta') + ' '
      str += clr(file.timestamp, 'cyan') + ' '
      str += progress(file.progress, 10) + ' '
      str += status

      return str + '\n'
    }, '') + '\n'
  }

  str += `Server-sent events: ${SSEStatus}`
  str += '\n'
  str += `Total size: ${totalSize}`

  return str
}

function clr (text, color) {
  return process.stdout.isTTY ? ansi.format(text, color) : text
}

function whitespace (len) {
  var res = ''
  while (res.length < len) res += ' '
  return res
}

function progress (curr, max) {
  var filledLength = Math.floor((curr / 100) * max)
  var emptyLength = max - filledLength
  var i = 1 + filledLength
  var j = i + emptyLength

  var str = StartDelimiter
  while (str.length < i) str += Filled
  while (str.length < j) str += Empty
  str += EndDelimiter
  return str
}

function raf (cb) {
  setTimeout(cb, 250)
}

function gzip (buffer, req, res) {
  var zipper = gzipMaybe(req, res)
  pump(zipper, res)
  zipper.end(buffer)
}

function time () {
  var date = new Date()
  var hours = numPad(date.getHours())
  var minutes = numPad(date.getMinutes())
  var seconds = numPad(date.getSeconds())
  return `${hours}:${minutes}:${seconds}`
}

function numPad (num) {
  if (num < 10) num = '0' + num
  return num
}

function cors (req, res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-method', '*')
  res.setHeader('access-control-allow-header', '*')
  res.setHeader('access-control-allow-credentials', 'true')
}