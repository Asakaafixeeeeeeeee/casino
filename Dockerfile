# Serves the static website (HTML/CSS/JS) for a Render service that is set to the Docker runtime.
# The Blueprint's asakaa-casino service is a native static site and does not use this file.
FROM nginx:1.27-alpine

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY . /usr/share/nginx/html

# Render sets PORT; the nginx image substitutes it into the template at start-up.
ENV PORT=10000
EXPOSE 10000
