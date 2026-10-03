<script setup lang="ts">
useHead({ title: 'Account · Ecommerce' })

const { user, isAuthenticated, isAdmin, ensureLoaded, refresh, login, logout } = useAuth()

onMounted(() => void ensureLoaded())
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-2xl font-semibold">
      Account
    </h1>

    <UCard v-if="isAuthenticated && user">
      <template #header>
        <h2 class="font-medium">
          Signed in as {{ user.name }}
        </h2>
      </template>

      <p class="text-sm text-muted">
        These authorities come from the API, which mapped your Cognito groups to roles. The API
        enforces them; the UI only reflects them.
      </p>

      <ul class="mt-3 flex flex-wrap gap-2">
        <li
          v-for="authority in user.authorities"
          :key="authority"
        >
          <UBadge
            :color="authority === 'ROLE_admin' ? 'primary' : 'neutral'"
            variant="subtle"
          >
            {{ authority }}
          </UBadge>
        </li>
      </ul>

      <UAlert
        v-if="isAdmin"
        class="mt-4"
        color="info"
        variant="soft"
        title="You are an admin"
        description="Product writes are allowed for this account."
      />

      <template #footer>
        <div class="flex gap-2">
          <UButton
            variant="soft"
            color="neutral"
            @click="refresh"
          >
            Refresh
          </UButton>
          <UButton
            variant="soft"
            color="error"
            @click="logout"
          >
            Sign out
          </UButton>
        </div>
      </template>
    </UCard>

    <UCard v-else>
      <template #header>
        <h2 class="font-medium">
          Not signed in
        </h2>
      </template>

      <p class="text-sm text-muted">
        Signing in takes you to the Cognito hosted UI, then back here. The browser only ever holds an
        <code>httpOnly</code> session cookie.
      </p>

      <template #footer>
        <UButton @click="login()">
          Sign in
        </UButton>
      </template>
    </UCard>
  </section>
</template>
