# Hestia Nginx proxy template for Kopi Sawah (HTTP).
# Keep HTTP free of authentication and return 503 until a trusted TLS certificate exists.
server {
	listen      %ip%:%proxy_port%;
	server_name %domain_idn% %alias_idn%;
	error_log   /var/log/%web_system%/domains/%domain%.error.log error;

	include %home%/%user%/conf/web/%domain%/nginx.forcessl.conf*;
	include %home%/%user%/conf/web/%domain%/nginx.conf_*;

	location / {
		return 503;
	}
}
