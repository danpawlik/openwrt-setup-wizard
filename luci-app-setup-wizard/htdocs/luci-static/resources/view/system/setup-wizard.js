'use strict';
'require view';
'require dom';
'require ui';
'require uci';
'require rpc';
'require network';

var callTimezones = rpc.declare({
	object: 'luci',
	method: 'getTimezones',
	expect: { '': {} }
});

var callSetPassword = rpc.declare({
	object: 'luci',
	method: 'setPassword',
	params: [ 'username', 'password' ],
	expect: { result: false }
});

var BANDS = { '2g': '2G', '5g': '5G', '6g': '6G', '60g': '60G' };
var GHZ = { '2G': '2.4', '5G': '5', '6G': '6', '60G': '60' };

var dirty = false; /* set when the wizard staged at least one change */

var PROTOS = {
	dhcp: _('Automatic (DHCP)'),
	static: _('Static address'),
	pppoe: _('PPPoE (login and password from your provider)')
};

function ssGet(k) {
	try { return sessionStorage.getItem(k); } catch (e) { return null; }
}

function ssSet(k, v) {
	try { (v == null) ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {}
}

function isIPv4(s) {
	var p = String(s || '').split('.');
	return p.length == 4 && p.every(function(x) { return /^\d{1,3}$/.test(x) && +x <= 255; });
}

function isIPv6(s) {
	return /^[0-9a-fA-F:.]+$/.test(s) && s.indexOf(':') >= 0;
}

function ip2int(s) {
	return s.split('.').reduce(function(a, x) { return a * 256 + (+x); }, 0);
}

function bitsToInt(bits) {
	return bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
}

function bitsToMask(bits) {
	var m = bitsToInt(bits);
	return [ 24, 16, 8, 0 ].map(function(s) { return (m >>> s) & 255; }).join('.');
}

function maskToBits(mask) {
	if (!isIPv4(mask))
		return null;

	var n = ip2int(mask), bits = 0;
	while (n & 0x80000000) {
		bits++;
		n = (n << 1) >>> 0;
	}

	return n ? null : bits;
}

function sameSubnet(a, b, bits) {
	var m = bitsToInt(bits);
	return ((ip2int(a) & m) >>> 0) == ((ip2int(b) & m) >>> 0);
}

function parseDns(s) {
	var l = String(s || '').split(/[\s,]+/).filter(Boolean);
	return l.every(function(x) { return isIPv4(x) || isIPv6(x); }) ? l : null;
}

function byteLength(s) {
	return new TextEncoder().encode(s).length;
}

function scanEncryption(res) {
	var enc = res.encryption, auth = enc ? L.toArray(enc.authentication) : [];

	if (!enc || !enc.enabled)
		return 'none';
	if (auth.indexOf('psk') >= 0)
		return 'psk2';
	if (auth.indexOf('sae') >= 0)
		return 'sae';

	return null; /* enterprise (802.1X) is not supported by the wizard */
}

/* Only touch the config when the value actually changes, so a re-run does
 * not restart services (or drop the connection) for options left as is. */
function set(conf, sid, opt, val) {
	var cur = uci.get(conf, sid, opt);

	if (Array.isArray(cur)) cur = cur.join(' ');
	if (Array.isArray(val)) val = val.length ? val : null;

	if (val == null) {
		if (cur != null) {
			uci.unset(conf, sid, opt);
			dirty = true;
		}
	}
	else if (String(cur) != (Array.isArray(val) ? val.join(' ') : String(val))) {
		uci.set(conf, sid, opt, val);
		dirty = true;
	}
}

function setBool(conf, sid, opt, on) {
	if ((uci.get(conf, sid, opt) == '1') != on) {
		uci.set(conf, sid, opt, on ? '1' : '0');
		dirty = true;
	}
}

/* UI helpers */

function field(label, input, desc) {
	return E('div', { 'class': 'cbi-value' }, [
		E('label', { 'class': 'cbi-value-title' }, label),
		E('div', { 'class': 'cbi-value-field' }, [
			input,
			desc ? E('div', { 'class': 'cbi-value-description' }, desc) : ''
		])
	]);
}

function textInput(obj, key, type) {
	return E('input', {
		'class': 'cbi-input-text',
		'type': type || 'text',
		'value': obj[key] != null ? obj[key] : '',
		'input': function(ev) { obj[key] = ev.target.value; }
	});
}

function checkbox(obj, key, label, onchange) {
	return E('label', {}, [
		E('input', {
			'type': 'checkbox',
			'checked': obj[key] ? '' : null,
			'change': function(ev) {
				obj[key] = ev.target.checked;
				if (onchange) onchange();
			}
		}), ' ', label
	]);
}

function select(obj, key, choices, onchange) {
	return E('select', {
		'class': 'cbi-input-select',
		'change': function(ev) {
			obj[key] = ev.target.value;
			if (onchange) onchange();
		}
	}, choices.map(function(c) {
		return E('option', { 'value': c[0], 'selected': (obj[key] == c[0]) ? '' : null }, c[1]);
	}));
}

/* Wizard steps: render(view) returns the step body, validate(view) returns an
 * error message or null; `when` hides steps that do not apply. */

var STEPS = [ {
	title: _('Administrator password'),
	render: function(v) {
		var p = v.m.password;
		return [
			E('p', _('Set a password to protect access to this router. Leave both fields empty to keep the current password.')),
			field(_('New password'), textInput(p, 'value', 'password')),
			field(_('Confirm password'), textInput(p, 'confirm', 'password'))
		];
	},
	validate: function(v) {
		var p = v.m.password;
		if (!p.value && !p.confirm)
			return null;
		if (p.value.length < 8)
			return _('The password must be at least 8 characters long.');
		if (p.value != p.confirm)
			return _('The passwords do not match.');
		return null;
	}
}, {
	title: _('Internet connection'),
	render: function(v) {
		var m = v.m, w = m.wan, st = v.env.wan, body = [];

		if (st.up)
			body.push(E('p', _('Connected to the internet: %s, address %s.').format(PROTOS[st.proto] || st.proto, st.ip || '-')));
		else if (st.carrier)
			body.push(E('p', _('A cable is connected to the WAN port, but there is no internet connection yet. Your provider may require PPPoE login details or a VLAN — check the settings below.')));
		else
			body.push(E('p', _('No cable detected in the WAN port.')));

		if (!st.carrier && !st.up && v.env.radios.length) {
			body.push(field(_('How should this router connect?'), select(m, 'mode', [
				[ 'router', _('Main router — I will connect the internet cable later') ],
				[ 'extend', _('Extend an existing WiFi network (repeater)') ]
			], v.redraw)));
		}

		if (m.mode == 'extend')
			return body;

		body.push(E('p', {}, checkbox(w, 'edit', _('Change internet connection settings'), v.redraw)));

		if (!w.edit)
			return body;

		body.push(field(_('Connection type'), select(w, 'proto', Object.keys(PROTOS).map(function(k) { return [ k, PROTOS[k] ]; }), v.redraw)));

		if (w.proto == 'static') {
			body.push(field(_('IP address'), textInput(w, 'ipaddr')));
			body.push(field(_('Netmask'), textInput(w, 'netmask')));
			body.push(field(_('Gateway'), textInput(w, 'gateway')));
			body.push(field(_('DNS servers'), textInput(w, 'dns'), _('Separate multiple addresses with spaces.')));
		}
		else if (w.proto == 'pppoe') {
			body.push(field(_('Username'), textInput(w, 'username')));
			body.push(field(_('Password'), textInput(w, 'password', 'password')));
		}

		body.push(E('p', {}, checkbox(w, 'vlan', _('My provider requires a VLAN'), v.redraw)));

		if (w.vlan)
			body.push(field(_('VLAN ID'), textInput(w, 'vlanId'), _('The number given by your provider (1–4094).')));

		return body;
	},
	validate: function(v) {
		var w = v.m.wan;

		if (v.m.mode == 'extend' || !w.edit)
			return null;
		if (!w.base)
			return _('The WAN port could not be determined.');

		if (w.proto == 'static') {
			if (!isIPv4(w.ipaddr))
				return _('Enter a valid IP address.');
			if (maskToBits(w.netmask) == null)
				return _('Enter a valid netmask, e.g. 255.255.255.0.');
			if (!isIPv4(w.gateway))
				return _('Enter a valid gateway address.');
			if (parseDns(w.dns) == null)
				return _('Enter valid DNS server addresses.');
		}
		else if (w.proto == 'pppoe' && (!w.username || !w.password)) {
			return _('Enter the PPPoE username and password from your provider.');
		}

		if (w.vlan && !(/^\d+$/.test(w.vlanId) && +w.vlanId >= 1 && +w.vlanId <= 4094))
			return _('The VLAN ID must be a number between 1 and 4094.');

		return null;
	}
}, {
	title: _('Network to extend'),
	when: function(v) { return v.m.mode == 'extend'; },
	render: function(v) {
		var r = v.m.repeater, body = [
			E('p', _('Choose the WiFi network of your main router. The main router must run OpenWrt with WDS enabled on its WiFi — routers set up with this wizard have it enabled.'))
		];

		if (v.env.radios.length > 1)
			body.push(field(_('Radio'), select(r, 'radio', v.env.radios.map(function(d) { return [ d.name, d.band ]; }), function() {
				v.scan = null;
				v.redraw();
			})));

		body.push(E('p', {}, E('button', {
			'class': 'btn cbi-button-action',
			'click': ui.createHandlerFn(v, 'handleScan')
		}, v.scan ? _('Scan again') : _('Scan for networks'))));

		if (v.scan) {
			if (!v.scan.length)
				body.push(E('p', _('No networks found.')));
			else
				body.push(field(_('Network'), E('select', {
					'class': 'cbi-input-select',
					'change': function(ev) {
						var res = v.scan[+ev.target.value];
						r.ssid = res ? res.ssid : '';
						r.encryption = res ? scanEncryption(res) : 'none';
						v.redraw();
					}
				}, [ E('option', { 'value': '' }, _('-- choose --')) ].concat(v.scan.map(function(res, i) {
					return E('option', { 'value': i, 'selected': (res.ssid == r.ssid) ? '' : null },
						'%s (%d dBm%s)'.format(res.ssid, res.signal, scanEncryption(res) == 'none' ? ', ' + _('open') : ''));
				})))));
		}

		if (r.ssid && r.encryption != 'none')
			body.push(field(_('WiFi password'), textInput(r, 'key', 'password')));

		return body;
	},
	validate: function(v) {
		var r = v.m.repeater;
		if (!r.ssid)
			return _('Select the network to extend.');
		if (r.encryption == null)
			return _('This network uses enterprise (802.1X) security, which is not supported here.');
		if (r.encryption != 'none' && r.key.length < 8)
			return _('Enter the WiFi password of the network (at least 8 characters).');
		return null;
	},
	next: function(v) {
		/* repeat the main network by default; the WiFi step can change it */
		v.m.wifi.ssid = v.m.repeater.ssid;
		v.m.wifi.key = v.m.repeater.key;
	}
}, {
	title: _('Time zone'),
	render: function(v) {
		return [
			E('p', _('Select the time zone where this router is located.')),
			field(_('Time zone'), select(v.m, 'timezone', Object.keys(v.env.zones).sort().map(function(z) {
				return [ z, z.replace(/_/g, ' ') ];
			})))
		];
	},
	validate: function(v) {
		return v.env.zones[v.m.timezone] ? null : _('Select a time zone.');
	}
}, {
	title: _('WiFi'),
	render: function(v) {
		var wf = v.m.wifi, radios = v.env.radios;

		if (!radios.length)
			return E('p', _('This device has no wireless hardware.'));

		var body = [];

		if (radios.every(function(d) { return d.disabled; }))
			body.push(E('div', { 'class': 'alert-message notice' }, _('WiFi is currently off. Set a network name and password below to turn it on.')));

		body.push(field(_('Network name'), textInput(wf, 'ssid')));
		body.push(field(_('Password'), textInput(wf, 'key', 'password'), _('At least 8 characters.')));
		body.push(E('p', {}, checkbox(wf, 'shared', _('One network name for all bands'), v.redraw)));

		radios.forEach(function(d) {
			var name = wf.shared ? wf.ssid : wf.ssid + '_' + d.band;
			body.push(E('p', {}, checkbox(wf.radios, d.name, _('Enable %s GHz').format(GHZ[d.band] || d.band) +
				(wf.ssid ? ' — "%s"'.format(name) : ''), v.redraw)));
		});

		return body;
	},
	validate: function(v) {
		var wf = v.m.wifi, longest = '';

		v.env.radios.forEach(function(d) {
			var name = wf.shared ? wf.ssid : wf.ssid + '_' + d.band;
			if (wf.radios[d.name] && name.length > longest.length) longest = name;
		});

		if (!longest)
			return null; /* WiFi left off */
		if (!wf.ssid)
			return _('Enter a network name.');
		if (byteLength(longest) > 32)
			return _('The network name is too long (at most 32 bytes, including the band suffix).');
		if (wf.key.length < 8 || wf.key.length > 63)
			return _('The WiFi password must be 8 to 63 characters long.');
		return null;
	}
}, {
	title: _('Router address'),
	when: function(v) { return v.m.mode != 'extend'; },
	render: function(v) {
		var choices = [];
		for (var b = 16; b <= 30; b++)
			choices.push([ String(b), '/%d (%s)'.format(b, bitsToMask(b)) ]);

		return [
			E('p', _('The address of this router in your local network. Change it if your network already uses 192.168.1.x, e.g. when this router is connected behind another router.')),
			field(_('Router IP address'), textInput(v.m.lan, 'ipaddr')),
			field(_('Network size'), select(v.m.lan, 'bits', choices))
		];
	},
	validate: function(v) {
		var l = v.m.lan, bits = +l.bits, wan = v.env.wan, host;

		if (!isIPv4(l.ipaddr))
			return _('Enter a valid IP address.');

		host = (ip2int(l.ipaddr) & ~bitsToInt(bits)) >>> 0;
		if (host == 0 || host == (~bitsToInt(bits) >>> 0))
			return _('This address cannot be used for the router in the selected network size.');
		if (wan.ip && wan.bits && sameSubnet(l.ipaddr, wan.ip, Math.min(bits, wan.bits)))
			return _('This address overlaps with your internet connection (%s). Choose a different network, e.g. 192.168.2.1.').format(wan.ip);
		return null;
	}
}, {
	title: _('Optimizations (optional)'),
	render: function(v) {
		var o = v.m.opt;
		return [
			E('p', _('Optional settings that can improve performance. The defaults are fine for most users.')),
			E('p', {}, checkbox(o, 'sw', _('Software flow offloading'), function() { if (!o.sw) o.hw = false; v.redraw(); })),
			E('div', { 'class': 'cbi-value-description' }, _('Speeds up routing by bypassing parts of the firewall for established connections.')),
			E('p', {}, checkbox(o, 'hw', _('Hardware flow offloading'), function() { if (o.hw) o.sw = true; v.redraw(); })),
			E('div', { 'class': 'cbi-value-description' }, _('Moves established connections to the network hardware, where the device supports it. Requires software flow offloading.')),
			E('p', {}, checkbox(o, 'steering', _('Packet steering'))),
			E('div', { 'class': 'cbi-value-description' }, _('Spreads network processing across all CPU cores. Usually not needed together with hardware offloading.')),
			E('p', {}, checkbox(o, 'igmp', _('IGMP snooping'))),
			E('div', { 'class': 'cbi-value-description' }, _('Sends multicast traffic (e.g. IPTV) only to devices that requested it.')),
			field(_('Custom DNS servers'), textInput(o, 'dns'), _('Leave empty to use the DNS servers of your provider. Separate multiple addresses with spaces, e.g. 1.1.1.1 9.9.9.9.'))
		];
	},
	validate: function(v) {
		return parseDns(v.m.opt.dns) == null ? _('Enter valid DNS server addresses.') : null;
	}
}, {
	title: _('Summary'),
	render: function(v) {
		var rows = v.summary().map(function(r) {
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width:33%' }, E('strong', r[0])),
				E('td', { 'class': 'td left' }, r[1])
			]);
		});

		var body = [
			E('p', _('The following settings will be applied:')),
			E('table', { 'class': 'table' }, rows)
		];

		if (v.m.mode != 'extend' && v.m.lan.ipaddr != v.env.lan.ipaddr)
			body.push(E('div', { 'class': 'alert-message warning' },
				_('The router address changes to %s. After applying, connect to http://%s/ to continue.').format(v.m.lan.ipaddr, v.m.lan.ipaddr)));
		else if (v.m.mode == 'extend')
			body.push(E('div', { 'class': 'alert-message warning' },
				_('This router will get its address from your main router. After applying, find it in the client list of your main router to open this page again.')));

		return body;
	}
} ];

return view.extend({
	load: function() {
		return Promise.all([
			uci.load([ 'setupwizard', 'network', 'wireless', 'system', 'firewall', 'dhcp' ]),
			network.getNetwork('wan'),
			network.getWifiDevices(),
			callTimezones()
		]);
	},

	render: function(data) {
		var wan = data[1], wanDev = wan ? wan.getDevice() : null, devs = {}, radios = [];

		(data[2] || []).forEach(function(d) {
			var band = d.get('band') || (/a/.test(d.get('hwmode') || '') ? '5g' : '2g');
			devs[d.getName()] = d;
			radios.push({ name: d.getName(), band: BANDS[band] || band.toUpperCase(), disabled: d.get('disabled') == '1' });
		});

		this.env = {
			fresh: uci.get('setupwizard', 'state', 'done') != '1',
			zones: data[3] || {},
			devs: devs,
			radios: radios,
			wan: {
				up: wan ? wan.isUp() : false,
				proto: wan ? wan.getProtocol() : null,
				ip: wan ? wan.getIPAddr() : null,
				bits: (wan && typeof(wan.getNetmask) == 'function') ? maskToBits(wan.getNetmask()) : null,
				carrier: wanDev ? wanDev.getCarrier() : false
			}
		};

		this.m = this.initModel();
		this.root = E('div', { 'class': 'cbi-map' });
		this.step = 0;
		this.redraw = L.bind(this.draw, this, null);

		if (ssGet('setupwizard-applied')) {
			ssSet('setupwizard-applied', null);
			this.drawDone();
		}
		else {
			this.draw();
		}

		return this.root;
	},

	initModel: function() {
		var env = this.env;

		/* WAN: remember the untagged port so the VLAN can be changed later */
		var wanDev = uci.get('network', 'wan', 'device') || '',
		    base = uci.get('setupwizard', 'state', 'wan_device') || wanDev,
		    vm = wanDev.match(/^(.+)\.(\d+)$/),
		    vlan = !!(vm && vm[1] == base && base != wanDev),
		    proto = uci.get('network', 'wan', 'proto'),
		    dns = uci.get('network', 'wan', 'dns');

		/* LAN */
		var ip = uci.get('network', 'lan', 'ipaddr'), bits;
		if (Array.isArray(ip)) ip = ip[0];
		ip = ip || '192.168.1.1';
		if (ip.indexOf('/') >= 0) {
			bits = +ip.split('/')[1];
			ip = ip.split('/')[0];
		}
		else {
			bits = maskToBits(uci.get('network', 'lan', 'netmask') || '255.255.255.0') || 24;
		}
		env.lan = { ipaddr: ip, bits: String(bits) };

		/* WiFi: prefill from the first access point */
		var ap = uci.sections('wireless', 'wifi-iface').filter(function(s) { return (s.mode || 'ap') == 'ap'; })[0] || {},
		    ssid = ap.ssid || '',
		    suffixed = /_(2G|5G|6G)$/.test(ssid),
		    radios = {};

		env.radios.forEach(function(d) { radios[d.name] = env.fresh || !d.disabled; });

		/* Time zone: keep on re-run, otherwise guess from the browser */
		var zone = (uci.get('system', '@system[0]', 'zonename') || 'UTC').replace(/ /g, '_'), tz = null;
		if (env.fresh) {
			try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
			if (tz && env.zones[tz])
				zone = tz;
			else if (/^pl/i.test(document.documentElement.lang || navigator.language || ''))
				zone = 'Europe/Warsaw';
		}

		var fw = uci.sections('firewall', 'defaults')[0] || {},
		    br = uci.sections('network', 'device').filter(function(s) { return s.name == 'br-lan'; })[0] || {},
		    repeater = uci.sections('wireless', 'wifi-iface').filter(function(s) { return s.mode == 'sta' && s.wds == '1'; })[0];

		return {
			password: { value: '', confirm: '' },
			mode: repeater && !env.wan.carrier ? 'extend' : 'router',
			wan: {
				edit: false,
				proto: PROTOS[proto] ? proto : 'dhcp',
				ipaddr: uci.get('network', 'wan', 'ipaddr') || '',
				netmask: uci.get('network', 'wan', 'netmask') || '255.255.255.0',
				gateway: uci.get('network', 'wan', 'gateway') || '',
				dns: Array.isArray(dns) ? dns.join(' ') : (dns || ''),
				username: uci.get('network', 'wan', 'username') || '',
				password: uci.get('network', 'wan', 'password') || '',
				vlan: vlan,
				vlanId: vlan ? vm[2] : '',
				base: vlan ? vm[1] : base
			},
			repeater: {
				radio: repeater ? repeater.device : (env.radios[0] ? env.radios[0].name : ''),
				ssid: repeater ? repeater.ssid || '' : '',
				encryption: repeater ? repeater.encryption || 'none' : 'none',
				key: repeater ? repeater.key || '' : ''
			},
			timezone: zone,
			wifi: {
				ssid: suffixed ? ssid.replace(/_(2G|5G|6G)$/, '') : ssid,
				key: (ap.encryption && ap.encryption != 'none') ? ap.key || '' : '',
				shared: !suffixed,
				radios: radios
			},
			lan: { ipaddr: env.lan.ipaddr, bits: env.lan.bits },
			opt: {
				sw: env.fresh || fw.flow_offloading == '1',
				hw: env.fresh || fw.flow_offloading_hw == '1',
				steering: uci.get('network', 'globals', 'packet_steering') == '1',
				igmp: br.igmp_snooping == '1',
				dns: ''
			}
		};
	},

	steps: function() {
		return STEPS.filter(L.bind(function(s) { return !s.when || s.when(this); }, this));
	},

	draw: function(error) {
		var steps = this.steps(), st, last;

		this.step = Math.min(this.step, steps.length - 1);
		st = steps[this.step];
		last = (this.step == steps.length - 1);

		var skip = { dont: false };

		dom.content(this.root, [
			E('h2', {}, _('Setup Wizard')),
			E('div', { 'class': 'cbi-map-descr' }, _('Step %d of %d: %s').format(this.step + 1, steps.length, st.title)),
			error ? E('div', { 'class': 'alert-message warning' }, error) : '',
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, st.title) ].concat(st.render(this))),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('span', { 'class': 'left' }, [
					E('button', {
						'class': 'btn cbi-button',
						'click': ui.createHandlerFn(this, 'handleSkip', skip)
					}, _('Skip setup')), ' ',
					checkbox(skip, 'dont', _("Don't show this again"))
				]),
				this.step > 0 ? E('button', {
					'class': 'btn cbi-button',
					'click': L.bind(function() { this.step--; this.draw(); }, this)
				}, _('Back')) : '', ' ',
				last ? E('button', {
					'class': 'btn cbi-button-apply important',
					'click': ui.createHandlerFn(this, 'handleApply')
				}, _('Apply settings')) : E('button', {
					'class': 'btn cbi-button-action important',
					'click': L.bind(this.handleNext, this, st)
				}, _('Next'))
			])
		]);
	},

	drawDone: function() {
		dom.content(this.root, [
			E('h2', {}, _('Setup Wizard')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Setup complete')),
				E('p', _('Your router has been configured. You can change any setting later in the menu, or run this wizard again from System → Setup Wizard.')),
				E('button', {
					'class': 'btn cbi-button-action important',
					'click': function() { window.location = L.url('admin/status/overview'); }
				}, _('Go to overview'))
			])
		]);
	},

	handleNext: function(st) {
		var err = st.validate ? st.validate(this) : null;
		if (err)
			return this.draw(err);
		if (st.next)
			st.next(this);
		this.step++;
		this.draw();
	},

	handleScan: function() {
		var dev = this.env.devs[this.m.repeater.radio];
		if (!dev)
			return;

		return dev.getScanList().then(L.bind(function(list) {
			this.scan = (list || []).filter(function(r) { return r.ssid; })
				.sort(function(a, b) { return b.signal - a.signal; });
			this.draw();
		}, this)).catch(L.bind(function(e) {
			this.draw(_('Scanning failed: %s').format(e.message || e));
		}, this));
	},

	handleSkip: function(skip) {
		var go = function() { window.location = L.url('admin/status/overview'); };

		ssSet('setupwizard-skipped', '1');

		if (!skip.dont)
			return go();

		uci.set('setupwizard', 'state', 'dismissed', '1');
		return uci.save().then(function() { return uci.apply(); }).then(go, go);
	},

	summary: function() {
		var m = this.m, env = this.env, rows = [], opts = [];

		rows.push([ _('Administrator password'), m.password.value ? _('will be changed') : _('unchanged') ]);

		if (m.mode == 'extend')
			rows.push([ _('Internet connection'), _('Extend the WiFi network "%s"').format(m.repeater.ssid) ]);
		else if (m.wan.edit)
			rows.push([ _('Internet connection'), PROTOS[m.wan.proto] + (m.wan.vlan ? ', VLAN %s'.format(m.wan.vlanId) : '') ]);
		else
			rows.push([ _('Internet connection'), _('unchanged') ]);

		rows.push([ _('Time zone'), m.timezone.replace(/_/g, ' ') ]);

		if (!env.radios.length)
			rows.push([ _('WiFi'), _('no wireless hardware') ]);
		env.radios.forEach(function(d) {
			rows.push([ _('WiFi %s GHz').format(GHZ[d.band] || d.band),
				m.wifi.radios[d.name] ? '"%s"'.format(m.wifi.shared ? m.wifi.ssid : m.wifi.ssid + '_' + d.band) : _('off') ]);
		});

		rows.push([ _('Router address'), m.mode == 'extend' ? _('assigned by the main router') : '%s/%s'.format(m.lan.ipaddr, m.lan.bits) ]);

		if (m.opt.hw) opts.push(_('hardware flow offloading'));
		else if (m.opt.sw) opts.push(_('software flow offloading'));
		if (m.opt.steering) opts.push(_('packet steering'));
		if (m.opt.igmp) opts.push(_('IGMP snooping'));
		if (parseDns(m.opt.dns).length) opts.push(_('DNS: %s').format(parseDns(m.opt.dns).join(', ')));
		rows.push([ _('Optimizations'), opts.length ? opts.join(', ') : _('none') ]);

		return rows;
	},

	writeConfig: function() {
		var m = this.m, env = this.env, uplink = 'wan';

		/* stations created by the wizard (repeater uplinks) */
		var stations = uci.sections('wireless', 'wifi-iface').filter(function(s) { return s.mode == 'sta' && s.wds == '1'; });
		var removeStations = function() {
			stations.forEach(function(s) { uci.remove('wireless', s['.name']); dirty = true; });
		};

		if (m.mode == 'extend') {
			var r = m.repeater, sid;

			uplink = 'lan';
			removeStations();

			dirty = true;
			sid = uci.add('wireless', 'wifi-iface');
			uci.set('wireless', sid, 'device', r.radio);
			uci.set('wireless', sid, 'mode', 'sta');
			uci.set('wireless', sid, 'network', 'lan');
			uci.set('wireless', sid, 'ssid', r.ssid);
			uci.set('wireless', sid, 'encryption', r.encryption);
			if (r.encryption != 'none')
				uci.set('wireless', sid, 'key', r.key);
			uci.set('wireless', sid, 'wds', '1');
			set('wireless', r.radio, 'disabled', '0');

			/* bridged into the main network: take the address from the main
			 * router and leave DHCP to it */
			set('network', 'lan', 'proto', 'dhcp');
			set('network', 'lan', 'ipaddr', null);
			set('network', 'lan', 'netmask', null);
			set('dhcp', 'lan', 'ignore', '1');
		}
		else {
			removeStations();

			if (m.wan.edit) {
				var w = m.wan, dev = w.vlan ? w.base + '.' + w.vlanId : w.base;

				set('network', 'wan', 'proto', w.proto);
				set('network', 'wan', 'ipaddr', w.proto == 'static' ? w.ipaddr : null);
				set('network', 'wan', 'netmask', w.proto == 'static' ? w.netmask : null);
				set('network', 'wan', 'gateway', w.proto == 'static' ? w.gateway : null);
				set('network', 'wan', 'dns', w.proto == 'static' ? parseDns(w.dns) : null);
				set('network', 'wan', 'username', w.proto == 'pppoe' ? w.username : null);
				set('network', 'wan', 'password', w.proto == 'pppoe' ? w.password : null);
				set('network', 'wan', 'device', dev);
				if (uci.get('network', 'wan6'))
					set('network', 'wan6', 'device', w.proto == 'pppoe' ? '@wan' : dev);
				set('setupwizard', 'state', 'wan_device', w.vlan ? w.base : null);
			}

			set('network', 'lan', 'proto', 'static');
			set('network', 'lan', 'ipaddr', m.lan.ipaddr);
			set('network', 'lan', 'netmask', bitsToMask(+m.lan.bits));
			set('dhcp', 'lan', 'ignore', null);

			/* keep the DHCP pool inside the (possibly smaller) network */
			var hosts = Math.pow(2, 32 - m.lan.bits) - 2,
			    start = +(uci.get('dhcp', 'lan', 'start') || 100),
			    limit = +(uci.get('dhcp', 'lan', 'limit') || 150);
			if (start + limit - 1 > hosts) {
				start = Math.min(100, Math.max(2, Math.floor(hosts / 2)));
				set('dhcp', 'lan', 'start', String(start));
				set('dhcp', 'lan', 'limit', String(hosts - start + 1));
			}
		}

		/* time zone */
		var tzsid = uci.sections('system', 'system')[0]['.name'];
		set('system', tzsid, 'zonename', m.timezone);
		set('system', tzsid, 'timezone', env.zones[m.timezone] ? env.zones[m.timezone].tzstring : null);

		/* WiFi access points (with WDS so other routers can extend them) */
		env.radios.forEach(function(d) {
			var on = !!m.wifi.radios[d.name], ap, sid;

			if (!on) {
				/* the repeater uplink keeps its radio on */
				if (!(m.mode == 'extend' && m.repeater.radio == d.name))
					set('wireless', d.name, 'disabled', '1');
				return;
			}

			ap = uci.sections('wireless', 'wifi-iface').filter(function(s) {
				return s.device == d.name && (s.mode || 'ap') == 'ap';
			})[0];
			sid = ap ? ap['.name'] : uci.add('wireless', 'wifi-iface');

			set('wireless', sid, 'device', d.name);
			set('wireless', sid, 'mode', 'ap');
			set('wireless', sid, 'network', 'lan');
			set('wireless', sid, 'ssid', m.wifi.shared ? m.wifi.ssid : m.wifi.ssid + '_' + d.band);
			set('wireless', sid, 'encryption', d.band == '6G' ? 'sae' : 'sae-mixed'); /* 6 GHz requires WPA3 */
			set('wireless', sid, 'key', m.wifi.key);
			set('wireless', sid, 'wds', '1');
			set('wireless', d.name, 'disabled', '0');
		});

		/* optimizations */
		var fw = uci.sections('firewall', 'defaults')[0];
		if (fw) {
			setBool('firewall', fw['.name'], 'flow_offloading', m.opt.sw || m.opt.hw);
			setBool('firewall', fw['.name'], 'flow_offloading_hw', m.opt.hw);
		}

		if (!uci.get('network', 'globals') && m.opt.steering)
			uci.add('network', 'globals', 'globals');
		if (uci.get('network', 'globals'))
			setBool('network', 'globals', 'packet_steering', m.opt.steering);

		var br = uci.sections('network', 'device').filter(function(s) { return s.name == 'br-lan'; })[0];
		if (br)
			setBool('network', br['.name'], 'igmp_snooping', m.opt.igmp);

		var dns = parseDns(m.opt.dns);
		if (dns.length) {
			set('network', uplink, 'peerdns', '0');
			set('network', uplink, 'dns', dns);
		}

		set('setupwizard', 'state', 'done', '1');
	},

	handleApply: function() {
		var m = this.m, self = this;

		return (m.password.value ? callSetPassword('root', m.password.value) : Promise.resolve(true)).then(function(ok) {
			if (!ok)
				throw new Error(_('The password could not be changed.'));

			dirty = false;
			self.writeConfig();
			return uci.save();
		}).then(function() {
			/* do not bounce back into the wizard for the rest of this session */
			ssSet('setupwizard-skipped', '1');

			if (!dirty)
				return self.drawDone();

			ssSet('setupwizard-applied', '1');
			ui.changes.apply(true);
		}).catch(function(e) {
			self.draw(e.message || String(e));
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
