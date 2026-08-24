ARG AUTH_VERSION=v2.186.0

FROM golang:1.26.6-alpine3.23 AS build
ARG AUTH_VERSION
ENV GO111MODULE=on
ENV CGO_ENABLED=0
ENV GOOS=linux

RUN apk add --no-cache make git

WORKDIR /go/src/github.com/supabase/auth
RUN git clone --branch "${AUTH_VERSION}" --depth 1 https://github.com/supabase/auth.git .

# Patch 1: API katmaninda email'i lowercase'e cevirme (internal/api/mail.go validateEmail)
RUN grep -q 'return strings.ToLower(email), nil' internal/api/mail.go && \
    sed -i 's/return strings\.ToLower(email), nil/return email, nil/' internal/api/mail.go && \
    grep -qc 'return email, nil' internal/api/mail.go

# Patch 2: DB'ye yazarken email'i lowercase'e cevirme (NewUser + NewUserWithPasswordHash)
RUN test "$(grep -c 'Email:             storage.NullString(strings.ToLower(email)),' internal/models/user.go)" = "2" && \
    sed -i 's/Email:             storage\.NullString(strings\.ToLower(email)),/Email:             storage.NullString(email),/' internal/models/user.go && \
    test "$(grep -c 'Email:             storage.NullString(email),' internal/models/user.go)" = "2"

# Patch 3: duplicate-email kontrolunu case-insensitive TUT (IsDuplicatedEmail)
RUN grep -q 'Where("email = ?", strings.ToLower(email)).All(&identities)' internal/models/user.go && \
    sed -i 's/Where("email = ?", strings\.ToLower(email))\.All(&identities)/Where("LOWER(email) = ?", strings.ToLower(email)).All(\&identities)/' internal/models/user.go && \
    grep -q 'Where("LOWER(email) = ?", strings.ToLower(email)).All(&identities)' internal/models/user.go

RUN RELEASE_VERSION="${AUTH_VERSION}-case-preserving" make build

FROM alpine:3
RUN adduser -D -u 1000 supabase

RUN apk add --no-cache ca-certificates
COPY --from=build /go/src/github.com/supabase/auth/auth /usr/local/bin/auth
COPY --from=build /go/src/github.com/supabase/auth/migrations /usr/local/etc/auth/migrations/
RUN ln -s /usr/local/bin/auth /usr/local/bin/gotrue

ENV GOTRUE_DB_MIGRATIONS_PATH /usr/local/etc/auth/migrations

USER supabase
CMD ["auth"]
